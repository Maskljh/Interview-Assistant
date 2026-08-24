import type { Point } from './signalExtractors';

export interface LandmarkDetector {
  load(): Promise<void>;
  detect(video: HTMLVideoElement): Promise<Point[] | null>;
  dispose(): void;
}

interface FaceLandmarksResult {
  keypoints: { x: number; y: number; z: number }[];
}

interface DetectorLike {
  estimateFaces(image: HTMLVideoElement): Promise<FaceLandmarksResult[]>;
}

let cached: LandmarkDetector | null = null;
let loading: Promise<LandmarkDetector> | null = null;

export async function loadFaceLandmarkDetector(): Promise<LandmarkDetector> {
  if (cached) return cached;
  if (loading) return loading;
  loading = (async () => {
    try {
      const [{ createDetector, SupportedModels }] = await Promise.all([
        import('@tensorflow-models/face-landmarks-detection'),
        import('@tensorflow/tfjs'),
      ]);
      const raw = (await createDetector(
        SupportedModels.MediaPipeFaceMesh,
        { runtime: 'tfjs', maxFaces: 1, refineLandmarks: false },
      )) as unknown as DetectorLike;

      const detector: LandmarkDetector = {
        async load() {
          // createDetector already loads weights; kept for interface symmetry.
        },
        async detect(video) {
          const faces = await raw.estimateFaces(video);
          if (!faces || faces.length === 0 || faces[0].keypoints.length === 0) {
            return null;
          }
          const w = video.videoWidth || 1;
          const h = video.videoHeight || 1;
          const pts: Point[] = new Array(478);
          for (let i = 0; i < 478 && i < faces[0].keypoints.length; i++) {
            const k = faces[0].keypoints[i];
            pts[i] = { x: k.x / w, y: k.y / h, z: k.z / Math.max(w, h) };
          }
          return pts;
        },
        dispose() {
          cached = null;
          loading = null;
        },
      };
      cached = detector;
      return detector;
    } finally {
      loading = null;
    }
  })();
  return loading;
}
