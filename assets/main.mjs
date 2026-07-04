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

export const SIZE_LIMIT = 6 * 1024 * 1024; // 6MiB, above R2's 5MiB multipart minimum with more room for proxy limits.
const MAX_UPLOAD_ATTEMPTS = 8;
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

function loadUploadState(key, file) {
  try {
    const value = localStorage.getItem(uploadStateKey(key, file));
    if (!value) return null;
    const state = JSON.parse(value);
    if (
      state.key !== key ||
      state.size !== file.size ||
      state.lastModified !== file.lastModified ||
      state.chunkSize !== SIZE_LIMIT
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

function completedBytes(parts, fileSize) {
  return parts.reduce((total, part) => {
    if (!part) return total;
    const partEnd = Math.min(part.partNumber * SIZE_LIMIT, fileSize);
    const partStart = (part.partNumber - 1) * SIZE_LIMIT;
    return total + Math.max(partEnd - partStart, 0);
  }, 0);
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
  const totalChunks = Math.ceil(file.size / SIZE_LIMIT);
  let state = loadUploadState(key, file);
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
      chunkSize: SIZE_LIMIT,
      totalChunks,
      parts: [],
      createdAt: Date.now(),
    };
    saveUploadState(key, file, state);
  }
  const uploadId = state.uploadId;
  const uploadedParts = state.parts || [];

  if (typeof options?.onUploadProgress === "function" && uploadedParts.length) {
    options.onUploadProgress({
      loaded: completedBytes(uploadedParts, file.size),
      total: file.size,
    });
  }

  const promiseGenerator = function* () {
    for (let i = 1; i <= totalChunks; i++) {
      if (uploadedParts[i - 1]) continue;
      const chunk = file.slice((i - 1) * SIZE_LIMIT, i * SIZE_LIMIT);
      yield withUploadRetry(() =>
        axios.put(writeItemUrl(key, { partNumber: i, uploadId }), chunk, {
          onUploadProgress(progressEvent) {
            if (typeof options?.onUploadProgress !== "function") return;
            options.onUploadProgress({
              loaded: (i - 1) * SIZE_LIMIT + progressEvent.loaded,
              total: file.size,
            });
          },
        })
      ).then((res) => ({
        partNumber: i,
        etag: res.headers.etag,
      }));
    }
  };

  for (const part of promiseGenerator()) {
    const { partNumber, etag } = await part;
    uploadedParts[partNumber - 1] = { partNumber, etag };
    state.parts = uploadedParts;
    saveUploadState(key, file, state);
  }
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
