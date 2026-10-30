import { isReadOnlyMode } from './config.js';
import { CONFIRM_SECRET_ENV, loadConfirmSecret, loadOrderLimits } from './order-safety.js';
import { logger } from './utils/logger.js';

/**
 * Validates deployment-level settings that are not credentials (order caps, confirm secret) and logs the
 * write posture. Throws ConfigError so a bad value stops the server at startup instead of surfacing mid-order.
 */
export function validateStartupConfig(env: NodeJS.ProcessEnv = process.env): void {
  loadOrderLimits(env);
  if (!loadConfirmSecret(env)) {
    logger.warn(
      `${CONFIRM_SECRET_ENV} is not set: using a random per-process key. Order confirm tokens will not survive a restart and will not work across replicas.`,
    );
  }
  if (isReadOnlyMode(env)) {
    logger.info('READ_ONLY_MODE is on: write tools are hidden and refused. Set READ_ONLY_MODE=false to enable them.');
  } else {
    logger.warn('READ_ONLY_MODE=false: write tools (customers, orders, carts) are enabled.');
  }
}
