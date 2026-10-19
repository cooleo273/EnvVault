/** Global route prefix applied to every API route. */
export const API_PREFIX = 'api';

/** Current default REST API version. */
export const API_DEFAULT_VERSION = '1';

/** Base path for the current API version, e.g. `/api/v1`. */
export const API_BASE_PATH = `/${API_PREFIX}/v${API_DEFAULT_VERSION}`;
