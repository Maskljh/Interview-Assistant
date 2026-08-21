/**
 * 直传文件到阿里云 OSS（预签名 PUT URL）。
 * 使用 XMLHttpRequest 以获得真实上传进度。
 */
export function uploadToOSS(
  putUrl: string,
  file: File,
  onProgress?: (pct: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open('PUT', putUrl);
    xhr.setRequestHeader('Content-Type', file.type || 'application/octet-stream');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) {
        onProgress(Math.round((e.loaded / e.total) * 100));
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        resolve();
      } else {
        reject(new Error(`上传失败（${xhr.status}）`));
      }
    };
    xhr.onerror = () => reject(new Error('网络异常，上传失败'));
    xhr.send(file);
  });
}
