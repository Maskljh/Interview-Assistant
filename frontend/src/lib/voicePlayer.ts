export interface VoicePlayer {
  play(blob: Blob): Promise<void>;
  stop(): void;
  /** 当前播放音量水平 0..1；未播放时为 0 */
  getLevel(): number;
}

export function createVoicePlayer(): VoicePlayer {
  let audio: HTMLAudioElement | null = null;
  let objectUrl: string | null = null;
  let ctx: AudioContext | null = null;
  let analyser: AnalyserNode | null = null;
  let dataArray: Uint8Array<ArrayBuffer> | null = null;
  let level = 0;
  let rafId = 0;

  function sampleLevel(): void {
    if (analyser && dataArray) {
      analyser.getByteFrequencyData(dataArray);
      let sum = 0;
      for (let i = 0; i < dataArray.length; i++) sum += dataArray[i];
      level = Math.min(1, sum / dataArray.length / 128);
    }
    rafId = requestAnimationFrame(sampleLevel);
  }

  function stopSampling(): void {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = 0;
  }

  return {
    play(blob: Blob): Promise<void> {
      stop();
      objectUrl = URL.createObjectURL(blob);
      const element = new Audio(objectUrl);
      audio = element;
      // 用 AudioContext 连接分析器：volume 可听 + analyser 取数据
      // 兼容处理：某些环境 AudioContext 受限时降级为纯 audio 播放（getLevel 返回 0）
      try {
        if (!ctx) {
          const Ctor =
            window.AudioContext ??
            (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
          ctx = Ctor ? new Ctor() : null;
        }
        if (ctx) {
          const src = ctx.createMediaElementSource(element);
          analyser = ctx.createAnalyser();
          analyser.fftSize = 512;
          dataArray = new Uint8Array(analyser.frequencyBinCount);
          src.connect(analyser);
          analyser.connect(ctx.destination);
          sampleLevel();
        }
      } catch {
        // 分析器初始化失败不影响播放（getLevel 保持 0）
        analyser = null;
        dataArray = null;
      }

      return new Promise<void>((resolve, reject) => {
        element.onended = () => {
          stopSampling();
          cleanup();
          resolve();
        };
        element.onerror = () => {
          stopSampling();
          cleanup();
          reject(new Error('audio playback failed'));
        };
        void element.play().catch((err) => {
          stopSampling();
          cleanup();
          reject(err);
        });
      });
    },

    stop() {
      stopSampling();
      level = 0;
      if (audio) {
        audio.onended = null;
        audio.onerror = null;
        audio.pause();
        audio = null;
      }
      cleanup();
    },

    getLevel() {
      return level;
    },
  };

  function cleanup(): void {
    if (objectUrl) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }
}
