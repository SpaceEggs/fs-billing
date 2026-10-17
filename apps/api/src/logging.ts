import { pino, type DestinationStream } from 'pino';

export function createApiLogger(destination?: DestinationStream) {
  return pino(
    {
      redact: [
        'req.headers.cookie',
        'req.headers.authorization',
        'req.body',
        'res.headers.set-cookie',
      ],
    },
    destination,
  );
}
