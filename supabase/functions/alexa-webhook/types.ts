export type AlexaEnvelope = {
  version?: string;
  session?: {
    new?: boolean;
    sessionId?: string;
    attributes?: Record<string, unknown>;
    application?: { applicationId?: string };
    user?: { userId?: string };
  };
  context?: {
    System?: {
      application?: { applicationId?: string };
      user?: { userId?: string };
      device?: { deviceId?: string };
    };
  };
  request?: {
    type?: string;
    requestId?: string;
    timestamp?: string;
    locale?: string;
    intent?: {
      name?: string;
      slots?: Record<string, { value?: string }>;
    };
  };
};

export type LlmRoute = {
  key_id: string;
  provider: string;
  model: string;
  base_url: string;
  api_key: string;
  timeout_ms: number;
};

export type ApiKeyRoute = {
  key_id: string;
  provider: string;
  api_key: string;
};

export type ChatMessage = Record<string, unknown>;
