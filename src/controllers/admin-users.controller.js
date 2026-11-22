import { getDB } from '../config/database.js';
import {
  getAdminUserById,
  listAdminUsers,
  setAdminUserBlockStatus,
} from '../services/user.service.js';
import {
  validateAdminUserListQuery,
  validateBlockStatusBody,
  validateObjectIdParam,
} from '../validators/user.validator.js';

export function createAdminUsersController({ getDatabase = getDB } = {}) {
  return {
    async listUsers(req, res) {
      const query = validateAdminUserListQuery(req.query);
      const result = await listAdminUsers(query, getDatabase());

      return res.status(200).json({
        success: true,
        ...result,
      });
    },

    async getUserDetails(req, res) {
      const targetUserId = validateObjectIdParam(req.params.id);
      const user = await getAdminUserById(targetUserId, getDatabase());

      return res.status(200).json({
        success: true,
        user,
      });
    },

    async updateUserBlockStatus(req, res) {
      const targetUserId = validateObjectIdParam(req.params.id);
      const { isBlocked } = validateBlockStatusBody(req.body);
      const user = await setAdminUserBlockStatus(
        {
          actorId: req.user.id,
          targetUserId,
          isBlocked,
        },
        getDatabase(),
      );

      return res.status(200).json({
        success: true,
        message: isBlocked ? 'User account blocked.' : 'User account unblocked.',
        user,
      });
    },
  };
}

const defaultController = createAdminUsersController();

export const { listUsers, getUserDetails, updateUserBlockStatus } = defaultController;
