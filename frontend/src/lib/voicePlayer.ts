export interface VoicePlayer {
  play(blob: Blob): Promise<void>;
  stop(): void;
}

export function createVoicePlayer(): VoicePlayer {
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;

  return {
    play(blob: Blob): Promise<void> {
      stop();
      objectUrl = URL.createObjectURL(blob);
      const element = new Audio(objectUrl);
      audio = element;
      return new Promise<void>((resolve, reject) => {
        element.onended = () => {
          cleanup();
          resolve();
        };
        element.onerror = () => {
          cleanup();
          reject(new Error('audio playback failed'));
        };
        void element.play().catch(reject);
      });
    },
    stop,
  };

  function stop(): void {
    if (audio) {
      audio.onended = null;
      audio.onerror = null;
      audio.pause();
      audio = null;
    }
    cleanup();
  }

  function cleanup(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }
}
