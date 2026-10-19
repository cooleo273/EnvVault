import { HttpStatus, Param, ParseUUIDPipe } from '@nestjs/common';

/**
 * Route parameter that must be a UUID. Malformed ids are answered with 404,
 * like ids that do not exist, so probing reveals nothing.
 */
export const UuidParam = (name: string) =>
  Param(name, new ParseUUIDPipe({ errorHttpStatusCode: HttpStatus.NOT_FOUND }));
