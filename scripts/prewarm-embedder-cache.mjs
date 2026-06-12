import { mkdir, stat, writeFile } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'

const dtype = process.argv[2] ?? 'fp32'
const modelId = 'Xenova/all-MiniLM-L6-v2'
// Pin the model revision so cache contents and test inputs stay reproducible and
// cannot drift when the repo's `main` is updated. Overridable from CI.
const revision = process.env.HF_MODEL_REVISION || '751bff37182d3f1213fa05d7196b954e230abad9'
const cacheDir = './tmp/models'
const baseUrl = `https://huggingface.co/${modelId}/resolve/${revision}`
const maxAttempts = 3

// transformers.js resolves dtype -> onnx filename. We fetch files only and
// never create an inference session, so onnxruntime is not loaded here — its
// WebGPU native teardown aborts the process on Windows, which would otherwise
// falsely fail this prewarm step even though the download succeeded.
const onnxFile = dtype === 'fp32' ? 'onnx/model.onnx' : `onnx/model_${dtype}.onnx`
const files = ['config.json', 'tokenizer.json', 'tokenizer_config.json', onnxFile]

async function alreadyCached(path) {
  try {
    return (await stat(path)).size > 0
  } catch {
    return false
  }
}

async function download(file) {
  const dest = resolve(cacheDir, modelId, file)
  if (await alreadyCached(dest)) {
    console.error(`Already cached: ${file}`)
    return
  }
  await mkdir(dirname(dest), { recursive: true })
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await fetch(`${baseUrl}/${file}`)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const bytes = Buffer.from(await res.arrayBuffer())
      // Guard against a truncated download being cached as a valid model file
      // (a partial .onnx would fail cryptically at load time in the tests).
      const expected = Number(res.headers.get('content-length'))
      if (expected && bytes.length !== expected) {
        throw new Error(`size mismatch: got ${bytes.length}, expected ${expected}`)
      }
      await writeFile(dest, bytes)
      console.error(`Cached ${file} (${bytes.length} bytes)`)
      return
    } catch (error) {
      console.error(`Attempt ${attempt}/${maxAttempts} failed for ${file}: ${error.message}`)
      if (attempt === maxAttempts) throw error
      await new Promise((r) => setTimeout(r, attempt * 5000))
    }
  }
}

console.error(`Prewarming embedder cache: ${modelId}@${revision.slice(0, 7)} (dtype=${dtype})`)
for (const file of files) {
  await download(file)
}
console.error('Embedder cache prewarm completed')
