import { describe, it, expect } from 'vitest';
import { solveMathCaptcha } from '../src/services/wordpressCom.js';
import { LoginFailedError } from '../src/services/base.js';

describe('solveMathCaptcha', () => {
  describe('captcha question parsing', () => {
    it('should extract and solve basic arithmetic', () => {
      expect(solveMathCaptcha('What is 7 + 1?')).toBe('8');
      expect(solveMathCaptcha('What is 10 - 3?')).toBe('7');
      expect(solveMathCaptcha('What is 6 * 7?')).toBe('42');
      expect(solveMathCaptcha('What is 10 / 2?')).toBe('5');
    });

    it('should be case insensitive', () => {
      expect(solveMathCaptcha('what is 5 + 5?')).toBe('10');
      expect(solveMathCaptcha('WHAT IS 5 + 5?')).toBe('10');
      expect(solveMathCaptcha('What Is 5 + 5?')).toBe('10');
    });

    it('should handle expressions with whitespace', () => {
      expect(solveMathCaptcha('What is  7  +  1 ?')).toBe('8');
      expect(solveMathCaptcha('What is 10+5?')).toBe('15');
    });

    it('should handle complex expressions', () => {
      expect(solveMathCaptcha('What is 2 + 3 * 4?')).toBe('14');
      expect(solveMathCaptcha('What is (2 + 3) * 4?')).toBe('20');
    });
  });

  describe('error handling', () => {
    it('should throw on invalid question format', () => {
      expect(() => solveMathCaptcha('Calculate 5 + 5')).toThrow(LoginFailedError);
      expect(() => solveMathCaptcha('What is 5 + 5')).toThrow(LoginFailedError); // Missing ?
      expect(() => solveMathCaptcha('5 + 5?')).toThrow(LoginFailedError); // Missing "What is"
      expect(() => solveMathCaptcha('')).toThrow(LoginFailedError);
      expect(() => solveMathCaptcha('What is?')).toThrow(LoginFailedError); // Empty expression
    });

    it('should throw on invalid expressions with helpful messages', () => {
      try {
        solveMathCaptcha('Calculate 5 + 5');
      } catch (error) {
        expect(error).toBeInstanceOf(LoginFailedError);
        expect((error as Error).message).toContain('Unable to parse captcha question');
      }

      try {
        solveMathCaptcha('What is abc?');
      } catch (error) {
        expect(error).toBeInstanceOf(LoginFailedError);
        expect((error as Error).message).toContain('Failed to solve captcha');
      }
    });

    it('should propagate evaluation errors as LoginFailedError', () => {
      expect(() => solveMathCaptcha('What is 1 / 0?')).toThrow(LoginFailedError);
      expect(() => solveMathCaptcha('What is null?')).toThrow(LoginFailedError);
      expect(() => solveMathCaptcha('What is process.exit()?')).toThrow(LoginFailedError);
    });
  });
});
