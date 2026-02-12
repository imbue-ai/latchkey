import { describe, it, expect } from 'vitest';
import { evaluateMathExpression, MathEvalError } from '../src/mathEval.js';

describe('evaluateMathExpression', () => {
  describe('basic arithmetic operations', () => {
    it('should evaluate addition', () => {
      expect(evaluateMathExpression('7 + 1')).toBe('8');
      expect(evaluateMathExpression('10 + 5')).toBe('15');
      expect(evaluateMathExpression('0 + 0')).toBe('0');
    });

    it('should evaluate subtraction', () => {
      expect(evaluateMathExpression('10 - 3')).toBe('7');
      expect(evaluateMathExpression('5 - 5')).toBe('0');
      expect(evaluateMathExpression('3 - 7')).toBe('-4');
    });

    it('should evaluate multiplication', () => {
      expect(evaluateMathExpression('6 * 7')).toBe('42');
      expect(evaluateMathExpression('5 * 0')).toBe('0');
      expect(evaluateMathExpression('12 * 12')).toBe('144');
    });

    it('should evaluate division', () => {
      expect(evaluateMathExpression('10 / 2')).toBe('5');
      expect(evaluateMathExpression('15 / 3')).toBe('5');
      expect(evaluateMathExpression('7 / 2')).toBe('4'); // Rounds 3.5 to 4
    });
  });

  describe('complex expressions', () => {
    it('should respect order of operations', () => {
      expect(evaluateMathExpression('2 + 3 * 4')).toBe('14'); // Not 20
      expect(evaluateMathExpression('10 - 2 + 5')).toBe('13');
      expect(evaluateMathExpression('(2 + 3) * 4')).toBe('20'); // Parentheses
    });

    it('should handle floating point results by rounding', () => {
      expect(evaluateMathExpression('10 / 3')).toBe('3'); // 3.333... rounds to 3
      expect(evaluateMathExpression('7 / 2')).toBe('4'); // 3.5 rounds to 4
      expect(evaluateMathExpression('5 / 2')).toBe('3'); // 2.5 rounds to 3
      expect(evaluateMathExpression('9 / 2')).toBe('5'); // 4.5 rounds to 5
    });

    it('should handle negative numbers', () => {
      expect(evaluateMathExpression('-5 + 3')).toBe('-2');
      expect(evaluateMathExpression('-10 * 2')).toBe('-20');
      expect(evaluateMathExpression('5 + -3')).toBe('2');
    });

    it('should handle complex nested expressions', () => {
      expect(evaluateMathExpression('((10 + 5) * 2) - 3')).toBe('27');
      expect(evaluateMathExpression('100 / (2 + 3)')).toBe('20');
    });
  });

  describe('whitespace handling', () => {
    it('should handle expressions with or without whitespace', () => {
      expect(evaluateMathExpression('7+1')).toBe('8');
      expect(evaluateMathExpression('7 + 1')).toBe('8');
      expect(evaluateMathExpression('  7  +  1  ')).toBe('8');
    });
  });

  describe('error cases', () => {
    it('should throw on invalid expressions', () => {
      expect(() => evaluateMathExpression('abc')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('1 + ')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('1 ++')).toThrow(MathEvalError);
    });

    it('should throw on expressions that return non-numeric values', () => {
      expect(() => evaluateMathExpression('"5" + "5"')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('null')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('undefined')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('true')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('[1, 2, 3]')).toThrow(MathEvalError);
    });

    it('should throw on expressions that return Infinity or NaN', () => {
      expect(() => evaluateMathExpression('1 / 0')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('0 / 0')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('Infinity')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('NaN')).toThrow(MathEvalError);
    });

    it('should include helpful error messages', () => {
      try {
        evaluateMathExpression('abc');
      } catch (error) {
        expect(error).toBeInstanceOf(MathEvalError);
        expect((error as Error).message).toContain('Failed to evaluate expression');
      }

      try {
        evaluateMathExpression('null');
      } catch (error) {
        expect(error).toBeInstanceOf(MathEvalError);
        expect((error as Error).message).toContain('non-numeric value');
      }
    });
  });

  describe('security', () => {
    it('should timeout on infinite loops', () => {
      // The VM has a 1000ms timeout
      expect(() => evaluateMathExpression('(function(){while(true){}})() || 5')).toThrow(
        MathEvalError
      );
    });

    it('should not have access to Node.js APIs', () => {
      expect(() => evaluateMathExpression('process.exit()')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('require("fs")')).toThrow(MathEvalError);
    });

    it('should not have access to global objects', () => {
      expect(() => evaluateMathExpression('console.log(5)')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('global')).toThrow(MathEvalError);
      expect(() => evaluateMathExpression('globalThis')).toThrow(MathEvalError);
    });

    it('should prevent prototype pollution attempts', () => {
      expect(() => evaluateMathExpression('Object.prototype.polluted = true')).toThrow(
        MathEvalError
      );
      expect(() => evaluateMathExpression('[].__proto__.polluted = true')).toThrow(MathEvalError);
    });
  });
});
