const THUMBNAIL_SIZE = 144;

/**
 * @param {File} file
 */
export async function generateThumbnail(file) {
  const canvas = document.createElement("canvas");
  canvas.width = THUMBNAIL_SIZE;
  canvas.height = THUMBNAIL_SIZE;
  var ctx = canvas.getContext("2d");

  /** @type HTMLImageElement */
  if (file.type.startsWith("image/")) {
    const image = await new Promise((resolve) => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.src = URL.createObjectURL(file);
    });
    ctx.drawImage(image, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  } else if (file.type === "video/mp4") {
    // Generate thumbnail from video
    const video = await new Promise(async (resolve, reject) => {
      const video = document.createElement("video");
      video.muted = true;
      video.src = URL.createObjectURL(file);
      setTimeout(() => reject(new Error("Video load timeout")), 2000);
      await video.play();
      await video.pause();
      video.currentTime = 0;
      resolve(video);
    });
    ctx.drawImage(video, 0, 0, THUMBNAIL_SIZE, THUMBNAIL_SIZE);
  }

  /** @type Blob */
  const thumbnailBlob = await new Promise((resolve) =>
    canvas.toBlob((blob) => resolve(blob))
  );

  return thumbnailBlob;
}

/**
 * @param {Blob} blob
 */
export async function blobDigest(blob) {
  const digest = await crypto.subtle.digest("SHA-1", await blob.arrayBuffer());
  const digestArray = Array.from(new Uint8Array(digest));
  const digestHex = digestArray
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return digestHex;
}

export const SIZE_LIMIT = 6 * 1024 * 1024; // 6MiB, above R2's 5MiB multipart minimum.
const MiB = 1024 * 1024;
const MAX_UPLOAD_ATTEMPTS = 8;
const MAX_UPLOAD_PARTS = 10000;
const MAX_ADAPTIVE_CHUNK_SIZE = 96 * MiB;
const TARGET_MAX_PARTS = 8000;
const MIN_UPLOAD_CONCURRENCY = 1;
const MAX_UPLOAD_CONCURRENCY = 5;
const UPLOAD_STATE_PREFIX = "flaredrive:multipart:";

export function encodeObjectKey(key) {
  return key
    .split("/")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
}

export function writeItemUrl(key, params) {
  const query = params ? `?${new URLSearchParams(params)}` : "";
  return `/api/write/items/${encodeObjectKey(key)}${query}`;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function waitForOnline() {
  if (navigator.onLine) return Promise.resolve();
  return new Promise((resolve) => {
    window.addEventListener("online", resolve, { once: true });
  });
}

function isRetryableUploadError(error) {
  if (!error.response) return true;
  return error.response.status === 408 || error.response.status >= 500;
}

function uploadErrorMessage(error) {
  return (
    error?.response?.data?.error ||
    error?.response?.data ||
    error?.message ||
    "Upload failed"
  );
}

function roundUpToMiB(value) {
  return Math.ceil(value / MiB) * MiB;
}

export function getAdaptiveChunkSize(fileSize) {
  const chunkSize = Math.max(
    SIZE_LIMIT,
    roundUpToMiB(fileSize / TARGET_MAX_PARTS)
  );
  return Math.min(chunkSize, MAX_ADAPTIVE_CHUNK_SIZE);
}

export function getAdaptiveUploadConcurrency(fileSize, chunkSize) {
  const connection = navigator.connection || navigator.mozConnection || navigator.webkitConnection;
  const effectiveType = connection?.effectiveType || "";
  const downlink = Number(connection?.downlink || 0);
  let concurrency = 3;

  if (connection?.saveData || effectiveType.includes("2g")) {
    concurrency = 1;
  } else if (effectiveType === "3g" || downlink > 0 && downlink < 3) {
    concurrency = 2;
  } else if (effectiveType === "4g" && downlink >= 15) {
    concurrency = 4;
  }

  if (downlink >= 50) concurrency = 5;
  if (fileSize < chunkSize * 3) concurrency = 1;
  if (fileSize < chunkSize * 8) concurrency = Math.min(concurrency, 2);

  return Math.max(MIN_UPLOAD_CONCURRENCY, Math.min(MAX_UPLOAD_CONCURRENCY, concurrency));
}

async function withUploadRetry(operation) {
  let lastError;
  for (let attempt = 1; attempt <= MAX_UPLOAD_ATTEMPTS; attempt++) {
    try {
      await waitForOnline();
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadError(error) || attempt === MAX_UPLOAD_ATTEMPTS) {
        break;
      }
      await waitForOnline();
      await sleep(Math.min(1000 * attempt, 8000));
    }
  }
  throw new Error(uploadErrorMessage(lastError));
}

function uploadStateKey(key, file) {
  return `${UPLOAD_STATE_PREFIX}${key}:${file.name}:${file.size}:${file.lastModified}`;
}

function loadUploadState(key, file, chunkSize) {
  try {
    const value = localStorage.getItem(uploadStateKey(key, file));
    if (!value) return null;
    const state = JSON.parse(value);
    if (
      state.key !== key ||
      state.size !== file.size ||
      state.lastModified !== file.lastModified ||
      state.chunkSize !== chunkSize
    ) {
      return null;
    }
    return state;
  } catch {
    return null;
  }
}

function saveUploadState(key, file, state) {
  try {
    localStorage.setItem(
      uploadStateKey(key, file),
      JSON.stringify({ ...state, updatedAt: Date.now() })
    );
  } catch {
    // Upload can still continue when localStorage is unavailable.
  }
}

function clearUploadState(key, file) {
  try {
    localStorage.removeItem(uploadStateKey(key, file));
  } catch {
    // Nothing to clear.
  }
}

function completedBytes(parts, fileSize, chunkSize) {
  return parts.reduce((total, part) => {
    if (!part) return total;
    const partEnd = Math.min(part.partNumber * chunkSize, fileSize);
    const partStart = (part.partNumber - 1) * chunkSize;
    return total + Math.max(partEnd - partStart, 0);
  }, 0);
}

function emitUploadProgress(options, uploadedParts, inFlightProgress, fileSize, chunkSize) {
  if (typeof options?.onUploadProgress !== "function") return;
  const inFlightBytes = Object.values(inFlightProgress).reduce(
    (total, loaded) => total + loaded,
    0
  );
  options.onUploadProgress({
    loaded: Math.min(
      completedBytes(uploadedParts, fileSize, chunkSize) + inFlightBytes,
      fileSize
    ),
    total: fileSize,
  });
}

export async function singleUpload(key, file, options) {
  const headers = options?.headers || {};
  await withUploadRetry(() =>
    axios.put(writeItemUrl(key), file, {
      headers,
      onUploadProgress: options?.onUploadProgress,
    })
  );
}

/**
 * @param {string} key
 * @param {File} file
 * @param {Record<string, any>} options
 */
export async function multipartUpload(key, file, options) {
  const headers = options?.headers || {};
  headers["content-type"] = file.type;
  const chunkSize = getAdaptiveChunkSize(file.size);
  const totalChunks = Math.ceil(file.size / chunkSize);
  if (totalChunks > MAX_UPLOAD_PARTS) {
    throw new Error("File is too large for browser upload; use a larger upload route");
  }

  let state = loadUploadState(key, file, chunkSize);
  if (!state) {
    const uploadId = await withUploadRetry(() =>
      axios
        .post(writeItemUrl(key, { uploads: "" }), "", { headers })
        .then((res) => res.data.uploadId)
    );
    state = {
      uploadId,
      key,
      size: file.size,
      lastModified: file.lastModified,
      chunkSize,
      totalChunks,
      parts: [],
      createdAt: Date.now(),
    };
    saveUploadState(key, file, state);
  }
  const uploadId = state.uploadId;
  const uploadedParts = state.parts || [];

  const inFlightProgress = {};
  emitUploadProgress(options, uploadedParts, inFlightProgress, file.size, chunkSize);

  const missingPartNumbers = [];
  for (let i = 1; i <= totalChunks; i++) {
    if (!uploadedParts[i - 1]) missingPartNumbers.push(i);
  }

  let nextPartIndex = 0;
  async function uploadPart(partNumber) {
    const chunk = file.slice((partNumber - 1) * chunkSize, partNumber * chunkSize);
    const res = await withUploadRetry(() => {
      inFlightProgress[partNumber] = 0;
      emitUploadProgress(options, uploadedParts, inFlightProgress, file.size, chunkSize);
      return axios.put(writeItemUrl(key, { partNumber, uploadId }), chunk, {
          onUploadProgress(progressEvent) {
            inFlightProgress[partNumber] = progressEvent.loaded || 0;
            emitUploadProgress(options, uploadedParts, inFlightProgress, file.size, chunkSize);
          },
      });
    });
    delete inFlightProgress[partNumber];
    uploadedParts[partNumber - 1] = { partNumber, etag: res.headers.etag };
    state.parts = uploadedParts;
    saveUploadState(key, file, state);
    emitUploadProgress(options, uploadedParts, inFlightProgress, file.size, chunkSize);
  }

  async function uploadWorker() {
    while (nextPartIndex < missingPartNumbers.length) {
      const partNumber = missingPartNumbers[nextPartIndex++];
      await uploadPart(partNumber);
    }
  }

  const concurrency = getAdaptiveUploadConcurrency(file.size, chunkSize);
  const workerCount = Math.min(concurrency, missingPartNumbers.length);
  await Promise.all(Array.from({ length: workerCount }, () => uploadWorker()));

  const parts = uploadedParts.filter(Boolean).sort((a, b) => a.partNumber - b.partNumber);
  if (parts.length !== totalChunks) {
    throw new Error("Upload interrupted, please retry the same file");
  }
  await withUploadRetry(() =>
    axios.post(writeItemUrl(key, { uploadId }), {
      parts,
    })
  );
  clearUploadState(key, file);
}
