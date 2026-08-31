/**
 * @met4citizen/talkinghead 未自带 TypeScript 类型声明，
 * 这里按本项目实际用到的 API 面做最小声明。
 * 参考：https://github.com/met4citizen/TalkingHead（v1.7）
 */

declare module '@met4citizen/talkinghead' {
  /** showAvatar 的头像配置（本项目只用 url/body） */
  export interface TalkingHeadAvatar {
    /** GLB 文件 URL（必填） */
    url: string;
    /** 体型 'M' | 'F' */
    body?: string;
    /** 文本口型语言（本项目走音频驱动口型，不用） */
    lipsyncLang?: string;
    [key: string]: unknown;
  }

  export interface TalkingHeadOptions {
    /** 预加载的文本口型语言模块；传空数组避免运行时动态 import 相对路径模块 */
    lipsyncModules?: string[];
    /** 初始相机视角 */
    cameraView?: string;
    /** 渲染循环每帧回调（HeadAudio 的 update 挂在这里） */
    update?: (dt: number) => void;
    [key: string]: unknown;
  }

  export class TalkingHead {
    constructor(node: HTMLElement, options?: TalkingHeadOptions);
    /** TalkingHead 内部创建并使用的 AudioContext */
    audioCtx: AudioContext;
    /** 语音增益节点（HeadAudio 从这里取音频做口型检测） */
    audioSpeechGainNode: GainNode;
    /** 混响节点（加延迟对齐口型时重新接线用） */
    audioReverbNode: ConvolverNode;
    /** 头像 blendshape（viseme）表 */
    mtAvatar: Record<
      string,
      { value: number; newvalue: number; needsUpdate: boolean; [key: string]: unknown }
    >;
    /** 构造选项（update 回调可在初始化后补挂） */
    opt: TalkingHeadOptions;
    /** 加载并显示 GLB 头像 */
    showAvatar(
      avatar: TalkingHeadAvatar,
      onprogress?: (progress: number) => void,
    ): Promise<void>;
    /** 设置视角：full | mid | upper | head */
    setView(view: string, opt?: Record<string, unknown>): void;
    /** 音频入队播放（支持 AudioBuffer 或 PCM 分块） */
    speakAudio(
      r: { audio: AudioBuffer; [key: string]: unknown },
      opt?: Record<string, unknown>,
      onsubtitles?: ((s: string) => void) | null,
    ): void;
    /** 在语音队列尾挂回调：队列处理到该标记时触发（用于感知播完） */
    speakMarker(onmarker: () => void): Promise<void>;
    /** 停止播放并清空语音队列 */
    stopSpeaking(): void;
    /** 让头像看向镜头 t 毫秒 */
    lookAtCamera(t: number): void;
    /** 启停渲染循环 */
    start(): void;
    stop(): void;
  }
}
