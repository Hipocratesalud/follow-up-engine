import { describe, expect, it } from 'vitest';
import { ApiError } from '../api/client.ts';
import { errorMessage } from './states.tsx';

describe('errorMessage', () => {
  it.each([
    [403, 'insufficient_scope', 'La clave de API no tiene el permiso "inbox:act".'],
    [429, 'rate_limited', 'Demasiadas peticiones.'],
    [413, 'payload_too_large', 'El cuerpo supera el máximo de 64 KB.'],
    [400, 'invalid_cursor', 'El cursor de paginación no es válido.'],
  ])('words %i %s for the team, without integrator terms', (status, code, serverMessage) => {
    const message = errorMessage(new ApiError(status, code, serverMessage));
    expect(message).not.toBe(serverMessage);
    expect(message).not.toMatch(/inbox:|cursor|KB|API/);
  });

  it('keeps the server message for other errors', () => {
    expect(errorMessage(new ApiError(409, 'invalid_transition', 'Ya está resuelto.'))).toBe(
      'Ya está resuelto.',
    );
  });
});
