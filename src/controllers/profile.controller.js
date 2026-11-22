import { getDB } from '../config/database.js';
import { getCurrentUserProfile, updateCurrentUserProfile } from '../services/user.service.js';
import { validateProfileUpdate } from '../validators/user.validator.js';

export function createProfileController({ getDatabase = getDB } = {}) {
  return {
    async getMyProfile(req, res) {
      const profile = await getCurrentUserProfile(req.user.id, getDatabase());
      return res.status(200).json({
        success: true,
        profile,
      });
    },

    async updateMyProfile(req, res) {
      const updates = validateProfileUpdate(req.body);
      const profile = await updateCurrentUserProfile(
        {
          userId: req.user.id,
          actorRole: req.user.role,
          updates,
        },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: 'Profile updated successfully.',
        profile,
      });
    },
  };
}

const defaultController = createProfileController();

export const { getMyProfile, updateMyProfile } = defaultController;
