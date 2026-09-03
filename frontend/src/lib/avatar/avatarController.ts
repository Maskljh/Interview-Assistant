/**
 * 数字人面试官控制器：封装 TalkingHead（3D 渲染 + 语音播放）
 * 与 HeadAudio（音频驱动口型）的完整生命周期。
 *
 * 降级链（语音播放永不受阻，只影响视觉）：
 *   Level 1  HeadAudio 音频驱动口型（默认）
 *   Level 2  TalkingHead 内置音量驱动口型（HeadAudio 初始化失败时）
 *   Level 3  整体失败 → available=false，页面回落 voicePlayer 纯语音
 *
 * 注意：TalkingHead / HeadAudio 均在 init 时动态 import（vite 自动分包），
 * 不进入主 bundle；模型与 worklet 从 public/ 静态资源加载。
 */

import type { TalkingHead } from '@met4citizen/talkinghead';

export type AvatarStatus = 'idle' | 'loading' | 'ready' | 'failed';

export type SpeakResult = 'avatar' | 'fallback';

/** speak() 被 stop() 打断时抛出的内部信号 */
export class AvatarSpeechStopped extends Error {
  constructor() {
    super('avatar speech stopped');
    this.name = 'AvatarSpeechStopped';
  }
}

/** 引擎暴露给控制器的最小面（也是单测注入假引擎的接口） */
export interface AvatarEngine {
  head: TalkingHead;
  /** HeadAudio 节点；Level 2 降级时为 null */
  headaudio: {
    disconnect(): void;
    update(dt: number): void;
  } | null;
}

export type AvatarEngineFactory = (container: HTMLElement) => Promise<AvatarEngine>;

export interface AvatarController {
  /** 初始化引擎（幂等：重复调用直接返回首次结果） */
  init(container: HTMLElement): Promise<void>;
  /**
   * 用数字人朗读一段音频。
   * - 'avatar'：由数字人播放完成（Promise 在音频结束后 resolve）
   * - 'fallback'：数字人不可用/入队前出错，调用方应用 voicePlayer 兜底
   * - 抛出 AvatarSpeechStopped：播放被 stop() 主动打断，调用方应静默放弃
   */
  speak(blob: Blob): Promise<SpeakResult>;
  /** 停止当前朗读并清空队列（打断 speak 的等待） */
  stop(): void;
  /** 开/关渲染循环（面板隐藏时停渲染省 GPU） */
  setRenderingEnabled(on: boolean): void;
  /** 释放资源（页面卸载时调用） */
  dispose(): void;
  getStatus(): AvatarStatus;
  getErrorMessage(): string;
  /** 订阅状态变化，返回取消订阅函数 */
  subscribe(listener: (status: AvatarStatus, message: string) => void): () => void;
}

function hasWebGL(): boolean {
  // 用临时 canvas 探测，避免在展示容器上提前消耗 WebGL 上下文类型
  try {
    const probe = document.createElement('canvas');
    return Boolean(probe.getContext('webgl2') ?? probe.getContext('webgl'));
  } catch {
    return false;
  }
}

/**
 * 默认引擎工厂：动态加载 TalkingHead 与 HeadAudio，完成接线。
 * HeadAudio 任一环节失败只降级到 Level 2（音量口型），不抛出。
 */
async function createDefaultEngine(container: HTMLElement): Promise<AvatarEngine> {
  const base = import.meta.env.BASE_URL;
  const { TalkingHead: Head } = await import('@met4citizen/talkinghead');

  // lipsyncModules 传空：我们走音频驱动口型，避免运行时动态 import
  // 相对路径的语言模块（vite 打包后该路径不可解析）。
  const head = new Head(container, {
    lipsyncModules: [],
    cameraView: 'head',
  });

  await head.showAvatar(
    { url: `${base}avatars/brunette.glb`, body: 'F' },
    undefined,
  );
  head.setView('head');

  // ── Level 1：HeadAudio 音频驱动口型 ──
  let headaudio: AvatarEngine['headaudio'] = null;
  try {
    await head.audioCtx.audioWorklet.addModule(
      `${base}vendor/headaudio/headworklet.mjs`,
    );
    // public 静态资源里的 ES 模块只能按 URL 动态 import
    const mod = (await import(/* @vite-ignore */ `${base}vendor/headaudio/headaudio.mjs`)) as {
      HeadAudio: new (
        ctx: AudioContext,
        options?: {
          processorOptions?: Record<string, unknown>;
          parameterData?: Record<string, number>;
        },
      ) => AudioWorkletNode & {
        loadModel(url: string): Promise<void>;
        onvalue: ((key: string, value: number) => void) | null;
        update(dt: number): void;
      };
    };
    const node = new mod.HeadAudio(head.audioCtx, {
      parameterData: {
        // 后端 TTS 为成人中文女声/男声，略调高基频估计改善元音分类
        speakerMeanHz: 180,
      },
    });
    await node.loadModel(`${base}vendor/headaudio/model-en-mixed.bin`);

    // 语音 → HeadAudio（检测口型）；加 ~80ms 延迟补偿处理时延，保证音画同步
    head.audioSpeechGainNode.disconnect(head.audioReverbNode);
    const delayNode = head.audioCtx.createDelay(0.5);
    delayNode.delayTime.value = 0.08;
    head.audioSpeechGainNode.connect(delayNode);
    delayNode.connect(head.audioReverbNode);
    head.audioSpeechGainNode.connect(node);

    node.onvalue = (key, value) => {
      const mt = head.mtAvatar[key];
      if (mt) Object.assign(mt, { newvalue: value, needsUpdate: true });
    };
    // 把 HeadAudio 的逐帧处理挂进 TalkingHead 渲染循环
    head.opt.update = node.update.bind(node);

    headaudio = node;
  } catch {
    // Level 2：TalkingHead 内置音量驱动口型（audioAnalyzerNode）仍在，
    // 只是元音精度更低，无需额外接线。
  }

  return { head, headaudio };
}

export function createAvatarController(
  engineFactory: AvatarEngineFactory = createDefaultEngine,
): AvatarController {
  let status: AvatarStatus = 'idle';
  let message = '';
  let engine: AvatarEngine | null = null;
  let initPromise: Promise<void> | null = null;
  let disposed = false;
  /** 正在等待播完的 speak 的 reject（stop/dispose 时触发） */
  let pendingReject: (() => void) | null = null;
  const listeners = new Set<(status: AvatarStatus, message: string) => void>();

  function emit(next: AvatarStatus, msg: string): void {
    status = next;
    message = msg;
    for (const fn of listeners) fn(status, message);
  }

  return {
    init(container: HTMLElement): Promise<void> {
      if (initPromise) return initPromise;
      if (disposed || !container) return Promise.resolve();
      if (!hasWebGL()) {
        emit('failed', '当前环境不支持 3D 渲染，已切换纯语音');
        return Promise.resolve();
      }
      emit('loading', '');
      initPromise = (async () => {
        try {
          engine = await engineFactory(container);
          if (disposed) {
            // 初始化完成前页面已卸载：立即释放
            engine.head.stopSpeaking();
            engine.headaudio?.disconnect();
            engine.head.stop();
            engine = null;
            return;
          }
          emit('ready', '');
        } catch (err) {
          engine = null;
          console.warn('[avatar] 初始化失败，降级纯语音：', err);
          emit('failed', '数字人加载失败，已切换纯语音');
        }
      })();
      return initPromise;
    },

    async speak(blob: Blob): Promise<SpeakResult> {
      // 数字人仍在初始化（loading）时，先等待 init 落定再决策：
      // 等到的若是 ready 则走数字人口型，失败则回退纯语音。
      // 避免首段音频在模型加载完成前被误判为不可用（否则会出现"有时动嘴、有时纯语音"）。
      if (status === 'loading' && initPromise) {
        await initPromise.catch(() => undefined);
      }
      if (status !== 'ready' || !engine) return 'fallback';
      let buffer: AudioBuffer;
      try {
        const arrayBuffer = await blob.arrayBuffer();
        buffer = await engine.head.audioCtx.decodeAudioData(arrayBuffer);
      } catch {
        // 入队前失败：尚未发声，可安全回落 voicePlayer
        return 'fallback';
      }
      if (status !== 'ready' || !engine) return 'fallback';
      const eng = engine;

      return new Promise<SpeakResult>((resolve, reject) => {
        // speakAudio 入队即返回；用队列尾 marker 感知播完。
        // stopSpeaking() 会清空队列（marker 不会触发），由 stop() 主动 reject。
        const settle = () => {
          pendingReject = null;
          resolve('avatar');
        };
        pendingReject = () => {
          pendingReject = null;
          reject(new AvatarSpeechStopped());
        };
        try {
          eng.head.speakAudio({ audio: buffer });
          void eng.head.speakMarker(settle);
        } catch (err) {
          pendingReject = null;
          console.warn('[avatar] 入队失败，回落纯语音：', err);
          resolve('fallback');
        }
      });
    },

    stop(): void {
      if (!engine) return;
      try {
        engine.head.stopSpeaking();
      } catch {
        // 忽略销毁过程中的异常
      }
      if (pendingReject) pendingReject();
    },

    setRenderingEnabled(on: boolean): void {
      if (!engine) return;
      try {
        if (on) engine.head.start();
        else engine.head.stop();
      } catch {
        // 渲染循环启停失败不影响功能
      }
    },

    dispose(): void {
      disposed = true;
      this.stop();
      const current = engine;
      engine = null;
      initPromise = null;
      emit('idle', '');
      try {
        current?.headaudio?.disconnect();
        current?.head.stop();
        // 关闭 AudioContext 释放音频资源；渲染循环停止后再关更稳妥
        void current?.head.audioCtx.close().catch(() => undefined);
      } catch {
        // 忽略销毁过程中的异常
      }
    },

    getStatus(): AvatarStatus {
      return status;
    },

    getErrorMessage(): string {
      return message;
    },

    subscribe(listener: (next: AvatarStatus, msg: string) => void): () => void {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
