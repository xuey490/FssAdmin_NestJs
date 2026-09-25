import { utils } from '../../utils/utils';
import type { ApiVerifyCliOptions } from '../api-verifier.types';

export const parseVerifyApiArgs = (argv: string[]): ApiVerifyCliOptions => {
  const options: ApiVerifyCliOptions = {
    timeoutMs: 5000,
    output: `logs/verify/api-verify-result-${utils.formatTime(new Date(), 'yyyyMMddhhmmss')}.md`,
    failFast: false,
    allowUnsafe: false,
    fromOpenapi: true,
  };

  for (const arg of argv) {
    if (arg === '--fail-fast') {
      options.failFast = true;
      continue;
    }

    if (arg === '--allow-unsafe') {
      options.allowUnsafe = true;
      continue;
    }

    if (arg === '--no-openapi') {
      options.fromOpenapi = false;
      continue;
    }

    const [key, value] = arg.split('=');

    if (!key.startsWith('--') || value === undefined) {
      continue;
    }

    switch (key) {
      case '--base-url':
        options.baseUrl = value;
        break;
      case '--include':
        options.include = splitList(value);
        break;
      case '--exclude':
        options.exclude = splitList(value);
        break;
      case '--case':
        options.caseIds = splitList(value);
        break;
      case '--timeout':
        options.timeoutMs = Number(value);
        break;
      case '--output':
        options.output = value;
        break;
      case '--token':
        options.authToken = value;
        break;
    }
  }

  options.authToken ??= process.env.VERIFY_API_TOKEN;

  if (!Number.isFinite(options.timeoutMs) || options.timeoutMs <= 0) {
    options.timeoutMs = 5000;
  }

  return options;
};

const splitList = (value: string): string[] =>
  value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);

