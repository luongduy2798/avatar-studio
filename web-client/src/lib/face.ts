import {
  FaceLandmarker,
  FilesetResolver,
  type NormalizedLandmark,
} from '@mediapipe/tasks-vision'

const modelUrl =
  import.meta.env.VITE_MEDIAPIPE_MODEL_URL ??
  'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/latest/face_landmarker.task'

const wasmUrl =
  import.meta.env.VITE_MEDIAPIPE_WASM_URL ??
  'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@1.0.1/wasm'

let landmarkerPromise: Promise<FaceLandmarker> | null = null
let filesetPromise: ReturnType<typeof FilesetResolver.forVisionTasks> | null = null

const maxDetectionSide = 1280

export type FaceAnalysis = {
  cropBlob: Blob
  cropUrl: string
  faceCoverage: number
}

function getFileset() {
  if (!filesetPromise) {
    filesetPromise = FilesetResolver.forVisionTasks(wasmUrl)
  }
  return filesetPromise
}

function getLandmarker() {
  if (!landmarkerPromise) {
    landmarkerPromise = (async () => {
      const fileset = await getFileset()
      return FaceLandmarker.createFromOptions(fileset, {
        baseOptions: {
          modelAssetPath: modelUrl,
          delegate: 'GPU',
        },
        runningMode: 'IMAGE',
        numFaces: 2,
        minFaceDetectionConfidence: 0.55,
        minFacePresenceConfidence: 0.55,
        minTrackingConfidence: 0.5,
      })
    })().catch((error: unknown) => {
      landmarkerPromise = null
      filesetPromise = null
      throw error
    })
  }

  return landmarkerPromise
}

// Start loading the detector before the user chooses an image. The promise is
// shared with analyzeAndCropFace, so this never creates a second model.
export function warmupFaceLandmarker() {
  return getLandmarker()
}

function landmarkBounds(landmarks: Array<{ x: number; y: number }>) {
  const xs = landmarks.map((point) => point.x)
  const ys = landmarks.map((point) => point.y)
  return {
    left: Math.min(...xs),
    right: Math.max(...xs),
    top: Math.min(...ys),
    bottom: Math.max(...ys),
  }
}

function averageLandmark(landmarks: NormalizedLandmark[], indices: number[]) {
  const points = indices.map((index) => landmarks[index])
  return {
    x: points.reduce((sum, point) => sum + point.x, 0) / points.length,
    y: points.reduce((sum, point) => sum + point.y, 0) / points.length,
  }
}

function canvasToBlob(canvas: HTMLCanvasElement) {
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Không thể tạo ảnh crop.'))),
      'image/png',
    )
  })
}

export async function analyzeAndCropFace(image: HTMLImageElement): Promise<FaceAnalysis> {
  const landmarker = await getLandmarker()
  // MediaPipe returns normalized landmarks, so detection can run on a smaller
  // copy while the original, full-resolution image is still used for drawing.
  // This matters for phone photos (often 12–48 MP) and keeps the crop quality.
  const largestSide = Math.max(image.naturalWidth, image.naturalHeight)
  let detectionSource: HTMLImageElement | HTMLCanvasElement = image
  if (largestSide > maxDetectionSide) {
    const ratio = maxDetectionSide / largestSide
    const detectionCanvas = document.createElement('canvas')
    detectionCanvas.width = Math.max(1, Math.round(image.naturalWidth * ratio))
    detectionCanvas.height = Math.max(1, Math.round(image.naturalHeight * ratio))
    const detectionContext = detectionCanvas.getContext('2d')
    if (!detectionContext) {
      throw new Error('Trình duyệt không hỗ trợ canvas 2D.')
    }
    detectionContext.drawImage(image, 0, 0, detectionCanvas.width, detectionCanvas.height)
    detectionSource = detectionCanvas
  }

  const result = landmarker.detect(detectionSource)

  if (result.faceLandmarks.length === 0) {
    throw new Error('Không tìm thấy khuôn mặt trong ảnh.')
  }

  if (result.faceLandmarks.length > 1) {
    throw new Error('Ảnh cần chỉ có một khuôn mặt.')
  }

  const landmarks = result.faceLandmarks[0]
  const bounds = landmarkBounds(landmarks)
  const faceWidth = bounds.right - bounds.left
  const faceHeight = bounds.bottom - bounds.top
  const faceCoverage = faceWidth * faceHeight

  if (faceCoverage < 0.035) {
    throw new Error('Khuôn mặt quá nhỏ. Hãy dùng selfie gần hơn.')
  }

  // Measure angles in pixels: normalized x/y have different units on a
  // non-square photo, so atan2(dy, dx) in normalized coordinates is incorrect.
  const leftEye = averageLandmark(landmarks, [33, 133])
  const rightEye = averageLandmark(landmarks, [362, 263])
  const roll = Math.atan2(
    (rightEye.y - leftEye.y) * image.naturalHeight,
    (rightEye.x - leftEye.x) * image.naturalWidth,
  )
  const cosine = Math.cos(roll)
  const sine = Math.sin(roll)
  const uprightBounds = landmarkBounds(landmarks.map((point) => {
    const x = point.x * image.naturalWidth
    const y = point.y * image.naturalHeight
    return { x: cosine * x + sine * y, y: -sine * x + cosine * y }
  }))
  const faceWidthPx = uprightBounds.right - uprightBounds.left
  const faceHeightPx = uprightBounds.bottom - uprightBounds.top
  const centerX = (uprightBounds.left + uprightBounds.right) / 2
  const centerY = (uprightBounds.top + uprightBounds.bottom) / 2 - faceHeightPx * 0.15
  // Retain hair/ears and motion room for the decoder. The worker removes the
  // background AFTER expression synthesis, then fits the complete head set.
  const sourceSide = Math.max(faceWidthPx * 1.75, faceHeightPx * 1.9)
  const scale = 512 / sourceSide

  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 512
  const context = canvas.getContext('2d')
  if (!context) {
    throw new Error('Trình duyệt không hỗ trợ canvas 2D.')
  }

  context.fillStyle = '#808080'
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.translate(canvas.width / 2, canvas.height / 2)
  context.scale(scale, scale)
  context.translate(-centerX, -centerY)
  context.rotate(-roll)
  context.drawImage(image, 0, 0)

  const cropBlob = await canvasToBlob(canvas)
  return {
    cropBlob,
    cropUrl: URL.createObjectURL(cropBlob),
    faceCoverage,
  }
}
