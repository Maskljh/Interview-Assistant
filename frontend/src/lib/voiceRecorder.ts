export interface VoiceRecorder {
  stop(): Promise<Blob>;
  cancel(): void;
}

export async function startVoiceRecording(): Promise<VoiceRecorder> {
  if (
    typeof window === 'undefined' ||
    !navigator.mediaDevices?.getUserMedia ||
    typeof MediaRecorder === 'undefined'
  ) {
    throw new Error('voice recording is not supported');
  }

  const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  const mimeTypes = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4'];
  const mimeType = mimeTypes.find((type) => MediaRecorder.isTypeSupported(type));
  const recorder = mimeType
    ? new MediaRecorder(stream, { mimeType })
    : new MediaRecorder(stream);

  const chunks: Blob[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) {
      chunks.push(event.data);
    }
  };
  recorder.start();

  return {
    stop: () =>
      new Promise<Blob>((resolve, reject) => {
        if (recorder.state === 'inactive') {
          stopTracks(stream);
          resolve(new Blob(chunks, { type: mimeType || 'audio/webm' }));
          return;
        }
        recorder.onstop = () => {
          stopTracks(stream);
          const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
          void toPCM16(blob).then(resolve, () => resolve(blob));
        };
        recorder.onerror = () => {
          stopTracks(stream);
          reject(new Error('recording failed'));
        };
        recorder.stop();
      }),
    cancel: () => {
      if (recorder.state !== 'inactive') {
        recorder.onstop = null;
        recorder.onerror = null;
        recorder.stop();
      }
      stopTracks(stream);
    },
  };
}

async function toPCM16(blob: Blob): Promise<Blob> {
  const audioContext = new AudioContext();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
    const sampleRate = 16000;
    const length = Math.ceil(audioBuffer.duration * sampleRate);
    const offline = new OfflineAudioContext(1, length, sampleRate);
    const source = offline.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(offline.destination);
    source.start(0);
    const rendered = await offline.startRendering();
    const samples = rendered.getChannelData(0);
    const pcm = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      pcm[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return new Blob([pcm.buffer], { type: 'audio/pcm' });
  } finally {
    void audioContext.close();
  }
}

function stopTracks(stream: MediaStream): void {
  for (const track of stream.getTracks()) {
    track.stop();
  }
}
