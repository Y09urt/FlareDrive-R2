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
const MAX_UPLOAD_ATTEMPTS = 4;

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
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isRetryableUploadError(error) || attempt === MAX_UPLOAD_ATTEMPTS) {
        break;
      }
      await sleep(500 * attempt);
    }
  }
  throw new Error(uploadErrorMessage(lastError));
}

/**
 * @param {string} key
 * @param {File} file
 * @param {Record<string, any>} options
 */
export async function multipartUpload(key, file, options) {
  const headers = options?.headers || {};
  headers["content-type"] = file.type;

  const uploadId = await withUploadRetry(() =>
    axios
      .post(writeItemUrl(key, { uploads: "" }), "", { headers })
      .then((res) => res.data.uploadId)
  );
  const totalChunks = Math.ceil(file.size / SIZE_LIMIT);

  const promiseGenerator = function* () {
    for (let i = 1; i <= totalChunks; i++) {
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

  const uploadedParts = [];
  for (const part of promiseGenerator()) {
    const { partNumber, etag } = await part;
    uploadedParts[partNumber - 1] = { partNumber, etag };
  }
  await withUploadRetry(() =>
    axios.post(writeItemUrl(key, { uploadId }), {
      parts: uploadedParts,
    })
  );
}
