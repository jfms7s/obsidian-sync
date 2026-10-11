import { describe, expect, it } from 'vitest';
import { ApiError, ErrorCode, isVaultNotFound, NetworkError } from '../../src/api/errors';

describe('isVaultNotFound', () => {
  it('is true for VAULT_NOT_FOUND whatever the message says', () => {
    expect(isVaultNotFound(new ApiError(ErrorCode.VAULT_NOT_FOUND, 'vault not found', 404))).toBe(true);
    expect(isVaultNotFound(new ApiError(ErrorCode.VAULT_NOT_FOUND, 'reworded', 404))).toBe(true);
  });

  it('falls back to the message for 0.1.x servers, which sent NOT_FOUND', () => {
    expect(isVaultNotFound(new ApiError(ErrorCode.NOT_FOUND, 'vault not found', 404))).toBe(true);
  });

  it('is false for anything else that is not found', () => {
    expect(isVaultNotFound(new ApiError(ErrorCode.NOT_FOUND, 'chunk not found', 404))).toBe(false);
    expect(isVaultNotFound(new ApiError(ErrorCode.NOT_FOUND, 'no such endpoint', 404))).toBe(false);
    expect(isVaultNotFound(new ApiError(ErrorCode.INTERNAL, 'vault not found', 500))).toBe(false);
    expect(isVaultNotFound(new NetworkError('vault not found'))).toBe(false);
  });
});
