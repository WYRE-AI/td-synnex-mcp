/** Credentials for one request (gateway headers). The access token is a bearer token for the ION v3 API. */
export interface RequestCredentials {
  accountId: string;
  accessToken: string;
}
