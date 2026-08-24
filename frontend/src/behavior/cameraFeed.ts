export interface CameraFeed {
  video: HTMLVideoElement;
  stream: MediaStream;
  stop(): void;
}

export async function startCameraFeed(
  constraints: MediaStreamConstraints = {
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  },
): Promise<CameraFeed> {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error('getUserMedia unsupported');
  }
  const stream = await navigator.mediaDevices.getUserMedia(constraints);
  const video = document.createElement('video');
  video.srcObject = stream;
  video.muted = true;
  video.playsInline = true;
  await video.play();
  return {
    video,
    stream,
    stop() {
      for (const track of stream.getTracks()) track.stop();
      video.srcObject = null;
    },
  };
}
