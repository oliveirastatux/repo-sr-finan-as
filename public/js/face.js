// Reconhecimento facial no navegador (nada de foto sai do aparelho — só o
// "descritor" numérico de 128 posições).
import * as faceapi from '/vendor/face-api/face-api.esm.js';

let loaded = null;

export function loadModels() {
  if (!loaded) {
    loaded = Promise.all([
      faceapi.nets.tinyFaceDetector.loadFromUri('/models'),
      faceapi.nets.faceLandmark68Net.loadFromUri('/models'),
      faceapi.nets.faceRecognitionNet.loadFromUri('/models'),
    ]);
  }
  return loaded;
}

export async function startCamera(video) {
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
    audio: false,
  });
  video.srcObject = stream;
  await video.play();
  return () => stream.getTracks().forEach((t) => t.stop());
}

const detectorOptions = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });

/**
 * Detecta os rostos do quadro atual.
 * @returns {{count:number, face?:{descriptor:Float32Array, ear:number, boxRatio:number}}}
 */
export async function detect(video) {
  const results = await faceapi
    .detectAllFaces(video, detectorOptions)
    .withFaceLandmarks()
    .withFaceDescriptors();
  if (results.length !== 1) return { count: results.length };
  const r = results[0];
  return {
    count: 1,
    face: {
      descriptor: r.descriptor,
      ear: eyeAspectRatio(r.landmarks),
      boxRatio: r.detection.box.width / video.videoWidth,
    },
  };
}

// Eye Aspect Ratio: cai perto de zero quando o olho fecha.
function eyeAspectRatio(landmarks) {
  const ear = (eye) => {
    const d = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
    return (d(eye[1], eye[5]) + d(eye[2], eye[4])) / (2 * d(eye[0], eye[3]));
  };
  return (ear(landmarks.getLeftEye()) + ear(landmarks.getRightEye())) / 2;
}

/**
 * Prova de vida por piscada: exige olho aberto → fechado → aberto.
 * Uma foto parada não pisca, o que barra a fraude mais comum.
 * O limiar é relativo à média do próprio rosto (funciona com óculos e
 * formatos de olho diferentes).
 */
export class BlinkDetector {
  constructor() {
    this.reset();
  }

  reset() {
    this.baseline = [];
    this.closed = false;
    this.blinked = false;
    this.openDescriptors = [];
  }

  /** @returns {boolean} true quando a piscada foi concluída */
  push(face) {
    const avg = this.baseline.length
      ? this.baseline.reduce((a, b) => a + b, 0) / this.baseline.length
      : face.ear;
    if (this.baseline.length < 3) {
      this.baseline.push(face.ear);
      this.openDescriptors.push(face.descriptor);
      return false;
    }
    if (!this.closed && face.ear < avg * 0.72) {
      this.closed = true;
    } else if (this.closed && face.ear > avg * 0.88) {
      this.blinked = true;
      this.openDescriptors.push(face.descriptor);
    } else if (!this.closed) {
      this.baseline.push(face.ear);
      if (this.baseline.length > 8) this.baseline.shift();
      this.openDescriptors.push(face.descriptor);
      if (this.openDescriptors.length > 5) this.openDescriptors.shift();
    }
    return this.blinked;
  }

  /** Média dos descritores com olho aberto — mais estável que um quadro só. */
  descriptor() {
    return averageDescriptor(this.openDescriptors);
  }
}

export function averageDescriptor(list) {
  const out = new Array(128).fill(0);
  list.forEach((d) => d.forEach((v, i) => { out[i] += v / list.length; }));
  return out;
}
