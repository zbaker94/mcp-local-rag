import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { formatErrorForClient } from '../error-utils.js'

// Coercion + secure-by-default coverage for the client-facing formatter.
// (Previously exercised the removed `formatErrorMessage`; retargeted to the
// replacement API `formatErrorForClient`, which now returns only `.message`
// regardless of NODE_ENV.)
describe('formatErrorForClient (coercion + environment policy)', () => {
  let originalNodeEnv: string | undefined

  beforeEach(() => {
    originalNodeEnv = process.env['NODE_ENV']
  })

  afterEach(() => {
    if (originalNodeEnv === undefined) {
      process.env['NODE_ENV'] = undefined
    } else {
      process.env['NODE_ENV'] = originalNodeEnv
    }
  })

  describe('in production mode (NODE_ENV !== "development")', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'production'
    })

    it('should return only the error message', () => {
      const error = new Error('Something went wrong')
      const result = formatErrorForClient(error)
      expect(result).toBe('Something went wrong')
    })

    it('should return the error message even when stack is available', () => {
      const error = new Error('Production error')
      // Ensure stack exists
      expect(error.stack).toBeDefined()
      const result = formatErrorForClient(error)
      expect(result).toBe('Production error')
    })
  })

  describe('in development mode (NODE_ENV === "development")', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = 'development'
    })

    it('should return only the message and never the stack trace', () => {
      const error = new Error('Dev error')
      // A real Error has a stack containing the "Error:" header and frame info;
      // the client formatter must not expose any of it.
      expect(error.stack).toBeDefined()
      const result = formatErrorForClient(error)
      expect(result).toBe('Dev error')
      expect(result).not.toContain(' at ')
      expect(result).not.toContain('Error:')
    })
  })

  describe('when NODE_ENV is not set', () => {
    beforeEach(() => {
      process.env['NODE_ENV'] = undefined
    })

    it('should return only the error message (secure by default)', () => {
      const error = new Error('Default mode error')
      const result = formatErrorForClient(error)
      expect(result).toBe('Default mode error')
    })
  })

  describe('with non-Error thrown values', () => {
    describe('in production mode', () => {
      beforeEach(() => {
        process.env['NODE_ENV'] = 'production'
      })

      it('should return "null" when error is null', () => {
        const result = formatErrorForClient(null)
        expect(result).toBe('null')
      })

      it('should return "undefined" when error is undefined', () => {
        const result = formatErrorForClient(undefined)
        expect(result).toBe('undefined')
      })

      it('should return the string itself when error is a string', () => {
        const result = formatErrorForClient('string error')
        expect(result).toBe('string error')
      })

      it('should return stringified number when error is a number', () => {
        const result = formatErrorForClient(42)
        expect(result).toBe('42')
      })

      it('should return empty string when error is empty string', () => {
        const result = formatErrorForClient('')
        expect(result).toBe('')
      })

      it('should return message when object has string message property', () => {
        const result = formatErrorForClient({ message: 'obj error' })
        expect(result).toBe('obj error')
      })

      it('should return stringified object when object has non-string message', () => {
        const result = formatErrorForClient({ message: 123 })
        expect(result).toBe('[object Object]')
      })

      it('should return stringified object when object has no message', () => {
        const result = formatErrorForClient({ custom: true })
        expect(result).toBe('[object Object]')
      })
    })
  })
})
