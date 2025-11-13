/**
 * Parameter validation utilities for API endpoints
 */

export interface ValidationResult {
  isValid: boolean;
  errors: string[];
}

export interface ValidationOptions {
  required?: boolean;
  type?: 'string' | 'number' | 'boolean';
  pattern?: RegExp;
  minLength?: number;
  maxLength?: number;
  min?: number;
  max?: number;
  allowedValues?: string[];
}

/**
 * Validates a single parameter value
 */
export function validateParameter(
  value: unknown,
  name: string,
  options: ValidationOptions = {}
): ValidationResult {
  const errors: string[] = [];

  // Check required
  if (!validateRequired(value, options)) {
    errors.push(`${name} is required`);
    return { isValid: false, errors };
  }

  // If not required and value is empty, skip further validation
  if (!options.required && isEmpty(value)) {
    return { isValid: true, errors: [] };
  }

  // Type validation
  const typeErrors = validateType(value, name, options);
  errors.push(...typeErrors);

  // Pattern validation
  if (options.pattern && typeof value === 'string' && !options.pattern.test(value)) {
    errors.push(`${name} format is invalid`);
  }

  // Length validation for strings
  if (typeof value === 'string') {
    const lengthErrors = validateStringLength(value, name, options);
    errors.push(...lengthErrors);
  }

  // Range validation for numbers
  const numValue = options.type === 'number' ? Number(value) : value;
  if (typeof numValue === 'number' && !Number.isNaN(numValue)) {
    const rangeErrors = validateNumberRange(numValue, name, options);
    errors.push(...rangeErrors);
  }

  // Allowed values validation
  if (options.allowedValues && !options.allowedValues.includes(String(value))) {
    errors.push(`${name} must be one of: ${options.allowedValues.join(', ')}`);
  }

  return { isValid: errors.length === 0, errors };
}

function validateRequired(value: unknown, options: ValidationOptions): boolean {
  return !(options.required && (value === undefined || value === null || value === ''));
}

function isEmpty(value: unknown): boolean {
  return value === undefined || value === null || value === '';
}

function validateType(value: unknown, name: string, options: ValidationOptions): string[] {
  const errors: string[] = [];

  if (!options.type) return errors;

  switch (options.type) {
    case 'string':
      if (typeof value !== 'string') {
        errors.push(`${name} must be a string`);
      }
      break;
    case 'number':
      if (typeof value !== 'number' && Number.isNaN(Number(value))) {
        errors.push(`${name} must be a number`);
      }
      break;
    case 'boolean':
      if (typeof value !== 'boolean' && !['true', 'false'].includes(String(value).toLowerCase())) {
        errors.push(`${name} must be a boolean`);
      }
      break;
  }

  return errors;
}

function validateStringLength(value: string, name: string, options: ValidationOptions): string[] {
  const errors: string[] = [];

  if (options.minLength && value.length < options.minLength) {
    errors.push(`${name} must be at least ${options.minLength} characters`);
  }
  if (options.maxLength && value.length > options.maxLength) {
    errors.push(`${name} must be at most ${options.maxLength} characters`);
  }

  return errors;
}

function validateNumberRange(value: number, name: string, options: ValidationOptions): string[] {
  const errors: string[] = [];

  if (options.min !== undefined && value < options.min) {
    errors.push(`${name} must be at least ${options.min}`);
  }
  if (options.max !== undefined && value > options.max) {
    errors.push(`${name} must be at most ${options.max}`);
  }

  return errors;
}

/**
 * Validates multiple parameters and returns combined result
 */
export function validateParameters(
  params: Record<string, unknown>,
  rules: Record<string, ValidationOptions>
): ValidationResult {
  const allErrors: string[] = [];

  for (const [paramName, options] of Object.entries(rules)) {
    const result = validateParameter(params[paramName], paramName, options);
    if (!result.isValid) {
      allErrors.push(...result.errors);
    }
  }

  return { isValid: allErrors.length === 0, errors: allErrors };
}

/**
 * Common validation rules for the application
 */
export const ValidationRules = {
  controllerId: {
    required: true,
    type: 'string' as const,
    pattern: /^trade-controller-\d+$/,
    minLength: 16,
    maxLength: 20,
  },
  timestamp: {
    required: true,
    type: 'number' as const,
    min: 1000000000000, // Unix timestamp in milliseconds (reasonable lower bound)
    max: 3000000000000, // Future-proof upper bound
  },
  serviceTimestamp: {
    required: true,
    type: 'number' as const,
    min: 1000000000000,
    max: 3000000000000,
  },
  presetFilename: {
    required: true,
    type: 'string' as const,
    pattern: /\.json$/,
    minLength: 5,
    maxLength: 100,
  },
  logFile: {
    required: false,
    type: 'string' as const,
    pattern: /^[\w\-.]+\.log$/,
    minLength: 1,
    maxLength: 100,
  },
} as const;