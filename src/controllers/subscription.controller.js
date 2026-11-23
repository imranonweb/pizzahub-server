import { ensureDBConnected, getDB } from '../config/database.js';
import { verifyStripeWebhookSignature } from '../config/stripe.js';
import {
  createVendorCheckoutSession,
  createVendorPortalSession,
  getAvailableSubscriptionPlans,
  getVendorSubscriptionSummary,
  processStripeWebhookEvent,
} from '../services/subscription.service.js';
import {
  validateCreateCheckoutBody,
  validatePortalSessionBody,
} from '../validators/subscription.validator.js';

export function createSubscriptionController({
  getDatabase = getDB,
  stripeClient,
  verifyWebhook = verifyStripeWebhookSignature,
} = {}) {
  return {
    async listPlans(_req, res) {
      return res.status(200).json({
        success: true,
        plans: getAvailableSubscriptionPlans(),
      });
    },

    async getMySubscription(req, res) {
      const result = await getVendorSubscriptionSummary(req.user.id, getDatabase());
      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async createCheckout(req, res) {
      const payload = validateCreateCheckoutBody(req.body);
      const session = await createVendorCheckoutSession(
        {
          vendorId: req.user.id,
          plan: payload.plan,
          successUrl: payload.successUrl,
          cancelUrl: payload.cancelUrl,
        },
        { db: getDatabase(), stripeClient },
      );

      return res.status(201).json({
        success: true,
        ...session,
      });
    },

    async createPortal(req, res) {
      const { returnUrl } = validatePortalSessionBody(req.body);
      const portal = await createVendorPortalSession(
        {
          vendorId: req.user.id,
          returnUrl,
        },
        { db: getDatabase(), stripeClient },
      );

      return res.status(200).json({
        success: true,
        ...portal,
      });
    },

    async handleStripeWebhook(req, res) {
      const signature = req.headers['stripe-signature'];
      const event = verifyWebhook({
        rawBody: req.body,
        signature,
        stripeClient,
      });

      const db = getDatabase === getDB ? await ensureDBConnected() : await getDatabase();
      const outcome = await processStripeWebhookEvent(event, {
        db,
      });

      return res.status(200).json(outcome);
    },
  };
}

const defaultController = createSubscriptionController();

export const {
  listPlans,
  getMySubscription,
  createCheckout,
  createPortal,
  handleStripeWebhook,
} = defaultController;
