// Parser error types.
//
// Extracted into a dependency-free leaf module so helpers that the parser
// imports (e.g. `pdf-extract`) can throw the same structured errors without
// creating an import cycle back through `parser/index.ts`. `index.ts`
// re-exports both classes so existing import sites (`../parser/index.js`)
// keep working unchanged.

import { AppError } from '../utils/errors.js'

/**
 * Validation error (equivalent to 400)
 */
export class ValidationError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'parser', 'validation', cause)
    this.name = 'ValidationError'
  }
}

/**
 * File operation error (equivalent to 500)
 */
export class FileOperationError extends AppError {
  constructor(message: string, cause?: Error) {
    super(message, 'parser', 'io', cause)
    this.name = 'FileOperationError'
  }
}
