import { env, pipeline } from '@huggingface/transformers'

const [device = 'cpu', dtype = 'fp32'] = process.argv.slice(2)
const modelName = 'Xenova/all-MiniLM-L6-v2'
const cacheDir = './tmp/models'
const maxAttempts = 3

env.cacheDir = cacheDir

for (let attempt = 1; attempt <= maxAttempts; attempt++) {
  try {
    console.error(
      `Prewarming embedder cache for ${modelName} (device=${device}, dtype=${dtype}, attempt=${attempt}/${maxAttempts})`
    )
    const extractor = await pipeline('feature-extraction', modelName, { device, dtype })
    if (typeof extractor.dispose === 'function') {
      await extractor.dispose()
    }
    console.error('Embedder cache prewarm completed')
    process.exit(0)
  } catch (error) {
    console.error(error)
    if (attempt === maxAttempts) {
      process.exit(1)
    }
    await new Promise((resolve) => setTimeout(resolve, attempt * 5000))
  }
}
