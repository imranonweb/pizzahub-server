import { ObjectId } from 'mongodb';
import { getDB } from '../config/database.js';
import { createAuthHttpError } from '../config/jwt.js';
import { ORDER_LIST_SORT_OPTIONS } from '../validators/order.validator.js';
import {
  compareIsoCreatedAtDesc,
  fetchUsersMapByIds,
  paginateArray,
  runWithOptionalTransaction,
  toIsoString,
} from '../utils/service-helpers.js';
import {
  OBJECT_ID_HEX_REGEX,
  buildIdCandidates,
  buildObjectIdOrStringFilter,
} from '../utils/validation.js';
import { safeNotify } from './notification.service.js';

const ACTIVE_ORDER_STATUSES = new Set([
  'pending',
  'accepted',
  'preparing',
  'ready',
  'out_for_delivery',
]);

// Allowed vendor status transitions:
// - pending -> accepted | rejected
// - accepted -> preparing
// - preparing -> ready
// - terminal states (rejected, cancelled, delivered) cannot transition further
// - vendors cannot directly mark orders out_for_delivery or delivered
const VENDOR_ORDER_TRANSITIONS = Object.freeze({
  pending: new Set(['accepted', 'rejected']),
  accepted: new Set(['preparing']),
  preparing: new Set(['ready']),
  ready: new Set(),
  out_for_delivery: new Set(),
  delivered: new Set(),
  rejected: new Set(),
  cancelled: new Set(),
});

const SAFE_ORDER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  itemId: 1,
  customerId: 1,
  vendorId: 1,
  vendorName: 1,
  vendorLocation: 1,
  items: 1,
  subtotal: 1,
  total: 1,
  status: 1,
  deliveryAddress: 1,
  contactPhone: 1,
  orderNotes: 1,
  message: 1,
  deliveryDate: 1,
  statusHistory: 1,
  createdAt: 1,
  updatedAt: 1,
});

const SAFE_ORDER_MENU_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  vendorId: 1,
  itemName: 1,
  price: 1,
  location: 1,
  images: 1,
  status: 1,
});

const SAFE_ORDER_VENDOR_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
  businessName: 1,
  isBlocked: 1,
});

const SAFE_ORDER_CUSTOMER_PROJECTION = Object.freeze({
  _id: 1,
  id: 1,
  name: 1,
});

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function serializeStatusHistory(history) {
  if (!Array.isArray(history)) {
    return [];
  }

  return history.map((entry) => ({
    previousStatus: typeof entry.previousStatus === 'string' ? entry.previousStatus : null,
    status: typeof entry.status === 'string' ? entry.status : 'pending',
    timestamp: toIsoString(entry.timestamp),
    actorRole: typeof entry.actorRole === 'string' ? entry.actorRole : 'system',
    actorId: entry.actorId ? String(entry.actorId) : null,
    note: typeof entry.note === 'string' && entry.note.trim() ? entry.note.trim() : null,
  }));
}

function serializeOrderItems(items) {
  if (!Array.isArray(items)) {
    return [];
  }

  return items.map((item) => ({
    menuItemId: String(item.menuItemId ?? ''),
    itemName: typeof item.itemName === 'string' ? item.itemName : '',
    image: typeof item.image === 'string' && item.image ? item.image : '/images/auth-pizza-hero.jpg',
    quantity: Number(item.quantity ?? 1),
    unitPrice: Number(item.unitPrice ?? 0),
    lineTotal: Number(item.lineTotal ?? 0),
  }));
}

export function serializeOrderForCustomer(doc) {
  const items = serializeOrderItems(doc.items);
  const resolvedNotes =
    typeof doc.orderNotes === 'string' && doc.orderNotes
      ? doc.orderNotes
      : typeof doc.message === 'string'
        ? doc.message
        : '';

  return {
    id: String(doc._id ?? doc.id),
    itemId: doc.itemId ? String(doc.itemId) : items[0]?.menuItemId ?? null,
    customerId: String(doc.customerId ?? ''),
    vendorId: String(doc.vendorId ?? ''),
    vendorName: typeof doc.vendorName === 'string' ? doc.vendorName : 'Local Kitchen',
    vendorLocation: typeof doc.vendorLocation === 'string' ? doc.vendorLocation : '',
    items,
    subtotal: Number(doc.subtotal ?? 0),
    total: Number(doc.total ?? 0),
    status: typeof doc.status === 'string' ? doc.status : 'pending',
    deliveryAddress: typeof doc.deliveryAddress === 'string' ? doc.deliveryAddress : '',
    contactPhone: typeof doc.contactPhone === 'string' ? doc.contactPhone : '',
    orderNotes: resolvedNotes,
    message: resolvedNotes,
    deliveryDate: typeof doc.deliveryDate === 'string' ? doc.deliveryDate : null,
    statusHistory: serializeStatusHistory(doc.statusHistory),
    createdAt: toIsoString(doc.createdAt),
    updatedAt: doc.updatedAt ? toIsoString(doc.updatedAt) : toIsoString(doc.createdAt),
  };
}

export function serializeOrderForVendor(doc, customerDoc) {
  const items = serializeOrderItems(doc.items);
  const resolvedNotes =
    typeof doc.orderNotes === 'string' && doc.orderNotes
      ? doc.orderNotes
      : typeof doc.message === 'string'
        ? doc.message
        : '';

  return {
    id: String(doc._id ?? doc.id),
    itemId: doc.itemId ? String(doc.itemId) : items[0]?.menuItemId ?? null,
    customerId: String(doc.customerId ?? ''),
    customer: {
      id: String(doc.customerId ?? ''),
      name:
        typeof customerDoc?.name === 'string' && customerDoc.name.trim()
          ? customerDoc.name.trim()
          : 'PizzaHub Customer',
    },
    vendorId: String(doc.vendorId ?? ''),
    vendorName: typeof doc.vendorName === 'string' ? doc.vendorName : 'Local Kitchen',
    vendorLocation: typeof doc.vendorLocation === 'string' ? doc.vendorLocation : '',
    items,
    subtotal: Number(doc.subtotal ?? 0),
    total: Number(doc.total ?? 0),
    status: typeof doc.status === 'string' ? doc.status : 'pending',
    deliveryAddress: typeof doc.deliveryAddress === 'string' ? doc.deliveryAddress : '',
    contactPhone: typeof doc.contactPhone === 'string' ? doc.contactPhone : '',
    orderNotes: resolvedNotes,
    message: resolvedNotes,
    deliveryDate: typeof doc.deliveryDate === 'string' ? doc.deliveryDate : null,
    statusHistory: serializeStatusHistory(doc.statusHistory),
    createdAt: toIsoString(doc.createdAt),
    updatedAt: doc.updatedAt ? toIsoString(doc.updatedAt) : toIsoString(doc.createdAt),
  };
}

function defaultNoteForVendorStatus(status) {
  switch (status) {
    case 'accepted':
      return 'Order accepted by restaurant.';
    case 'rejected':
      return 'Order declined by restaurant.';
    case 'preparing':
      return 'Kitchen started preparing the order.';
    case 'ready':
      return 'Order is ready.';
    default:
      return `Status updated to ${status}.`;
  }
}

function sortOrders(orders, sortOption) {
  const sorted = [...orders];
  sorted.sort((a, b) => {
    if (sortOption === ORDER_LIST_SORT_OPTIONS.OLDEST) {
      if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;
      return a.id.localeCompare(b.id);
    } else if (sortOption === ORDER_LIST_SORT_OPTIONS.TOTAL_ASC) {
      if (a.total !== b.total) return a.total - b.total;
    } else if (sortOption === ORDER_LIST_SORT_OPTIONS.TOTAL_DESC) {
      if (a.total !== b.total) return b.total - a.total;
    }

    return compareIsoCreatedAtDesc(a.createdAt, b.createdAt, a.id, b.id);
  });
  return sorted;
}

function filterAndPaginateOrders(serializedOrders, { search, status, sort, page, limit }) {
  const normalizedSearch = search.toLowerCase();

  const filtered = serializedOrders.filter((order) => {
    if (status === 'active') {
      if (!ACTIVE_ORDER_STATUSES.has(order.status)) {
        return false;
      }
    } else if (status !== 'all' && order.status !== status) {
      return false;
    }

    if (normalizedSearch) {
      const itemNames = order.items.map((item) => item.itemName).join(' ');
      const customerName = order.customer?.name ?? '';
      const haystack = [
        order.id,
        order.vendorName,
        order.vendorLocation,
        order.deliveryAddress,
        customerName,
        itemNames,
      ]
        .join(' ')
        .toLowerCase();

      if (!haystack.includes(normalizedSearch)) {
        return false;
      }
    }

    return true;
  });

  const sorted = sortOrders(filtered, sort);
  const { items: orders, pagination } = paginateArray(sorted, page, limit);

  return {
    orders,
    pagination,
  };
}

async function persistOrdersAtomically(orderDocs, db) {
  const ordersCollection = db.collection('orders');

  if (orderDocs.length === 1) {
    const result = await ordersCollection.insertOne(orderDocs[0]);
    return [{ ...orderDocs[0], _id: result.insertedId }];
  }

  return runWithOptionalTransaction(db, async (session) => {
    if (typeof ordersCollection.insertMany === 'function') {
      const result = await ordersCollection.insertMany(orderDocs, session ? { session } : undefined);
      return orderDocs.map((doc, idx) => ({
        ...doc,
        _id: result.insertedIds[idx],
      }));
    }

    const inserted = [];
    for (const doc of orderDocs) {
      const result = await ordersCollection.insertOne(doc, session ? { session } : undefined);
      inserted.push({ ...doc, _id: result.insertedId });
    }
    return inserted;
  });
}

export async function createCustomerOrder({ customerId, payload }, db = getDB()) {
  const requestedIds = payload.items.map((line) => line.menuItemId);
  const idCandidates = requestedIds.flatMap((id) => buildIdCandidates(id));

  const menuDocs = await db
    .collection('menuItems')
    .find(
      {
        $or: [{ _id: { $in: idCandidates } }, { id: { $in: requestedIds } }],
      },
      { projection: SAFE_ORDER_MENU_PROJECTION },
    )
    .toArray();

  const menuMap = new Map();
  for (const doc of menuDocs) {
    if (doc._id) menuMap.set(String(doc._id), doc);
    if (doc.id) menuMap.set(String(doc.id), doc);
  }

  for (const line of payload.items) {
    const menuDoc = menuMap.get(line.menuItemId);
    if (!menuDoc || menuDoc.status !== 'approved') {
      throw createAuthHttpError(
        400,
        'One or more selected menu items are unavailable or inactive.',
      );
    }
    if (String(menuDoc.vendorId ?? '') === String(customerId)) {
      throw createAuthHttpError(403, 'You cannot order items from your own vendor kitchen.');
    }
  }

  const vendorIds = Array.from(
    new Set(payload.items.map((line) => String(menuMap.get(line.menuItemId).vendorId ?? ''))),
  ).filter(Boolean);
  const vendorCandidates = vendorIds.flatMap((id) => buildIdCandidates(id));

  const vendorDocs = await db
    .collection('users')
    .find(
      {
        $or: [{ _id: { $in: vendorCandidates } }, { id: { $in: vendorIds } }],
      },
      { projection: SAFE_ORDER_VENDOR_PROJECTION },
    )
    .toArray();

  const vendorMap = new Map();
  for (const vendor of vendorDocs) {
    if (vendor._id) vendorMap.set(String(vendor._id), vendor);
    if (vendor.id) vendorMap.set(String(vendor.id), vendor);
  }

  for (const vId of vendorIds) {
    const vendorDoc = vendorMap.get(vId);
    if (!vendorDoc || vendorDoc.isBlocked === true) {
      throw createAuthHttpError(
        400,
        'One or more selected menu items are currently unavailable.',
      );
    }
  }

  if (payload.deliveryDate) {
    const customerCandidates = buildIdCandidates(customerId);
    const existingDuplicate = await db.collection('orders').findOne(
      {
        customerId: { $in: customerCandidates },
        deliveryDate: payload.deliveryDate,
        status: { $in: Array.from(ACTIVE_ORDER_STATUSES) },
        $or: [
          { 'items.menuItemId': { $in: idCandidates } },
          { itemId: { $in: idCandidates } },
        ],
      },
      { projection: { _id: 1 } },
    );

    if (existingDuplicate) {
      throw createAuthHttpError(
        409,
        'An active order already exists for one of these items on the selected delivery date.',
      );
    }
  }

  // Group items by vendor so every vendor manages only their own isolated order.
  const itemsByVendor = new Map();
  for (const line of payload.items) {
    const menuDoc = menuMap.get(line.menuItemId);
    const vId = String(menuDoc.vendorId ?? '');
    if (!itemsByVendor.has(vId)) {
      itemsByVendor.set(vId, []);
    }
    const unitPrice = roundMoney(Number(menuDoc.price));
    if (!Number.isFinite(unitPrice) || unitPrice <= 0) {
      throw createAuthHttpError(400, 'Selected menu item has an invalid price.');
    }

    const firstImage =
      Array.isArray(menuDoc.images) && typeof menuDoc.images[0] === 'string' && menuDoc.images[0]
        ? menuDoc.images[0]
        : '/images/auth-pizza-hero.jpg';

    itemsByVendor.get(vId).push({
      menuItemId: OBJECT_ID_HEX_REGEX.test(line.menuItemId)
        ? new ObjectId(line.menuItemId)
        : line.menuItemId,
      itemName: String(menuDoc.itemName ?? ''),
      image: firstImage,
      quantity: line.quantity,
      unitPrice,
      lineTotal: roundMoney(unitPrice * line.quantity),
      location: typeof menuDoc.location === 'string' ? menuDoc.location : '',
    });
  }

  const now = new Date();
  const storedCustomerId = OBJECT_ID_HEX_REGEX.test(customerId)
    ? new ObjectId(customerId)
    : customerId;

  const orderDocs = [];
  for (const [vId, vendorLines] of itemsByVendor.entries()) {
    const vendorDoc = vendorMap.get(vId);
    const vendorName =
      typeof vendorDoc?.businessName === 'string' && vendorDoc.businessName.trim()
        ? vendorDoc.businessName.trim()
        : typeof vendorDoc?.name === 'string' && vendorDoc.name.trim()
          ? vendorDoc.name.trim()
          : 'Local Kitchen';
    const vendorLocation =
      vendorLines.find((entry) => entry.location)?.location || '';

    const subtotal = roundMoney(vendorLines.reduce((sum, entry) => sum + entry.lineTotal, 0));
    const snapshotItems = vendorLines.map(({ location: _loc, ...snapshot }) => snapshot);

    orderDocs.push({
      itemId: snapshotItems[0]?.menuItemId ?? null,
      customerId: storedCustomerId,
      vendorId: OBJECT_ID_HEX_REGEX.test(vId) ? new ObjectId(vId) : vId,
      vendorName,
      vendorLocation,
      items: snapshotItems,
      subtotal,
      total: subtotal,
      status: 'pending',
      deliveryAddress: payload.deliveryAddress,
      contactPhone: payload.contactPhone,
      orderNotes: payload.orderNotes,
      message: payload.orderNotes,
      ...(payload.deliveryDate ? { deliveryDate: payload.deliveryDate } : {}),
      statusHistory: [
        {
          previousStatus: null,
          status: 'pending',
          timestamp: now,
          actorRole: 'customer',
          actorId: String(customerId),
          note: 'Order placed by customer.',
        },
      ],
      createdAt: now,
      updatedAt: now,
    });
  }

  const insertedDocs = await persistOrdersAtomically(orderDocs, db);
  const serializedOrders = insertedDocs.map(serializeOrderForCustomer);

  await Promise.all(
    serializedOrders.flatMap((order) => [
      safeNotify(
        {
          userId: order.customerId,
          role: 'customer',
          type: 'order_placed',
          title: 'Order Placed',
          message: `Your order with ${order.vendorName} ($${order.total.toFixed(2)}) has been submitted and is Pending.`,
          relatedResourceId: order.id,
          link: `/dashboard/customer/orders/${order.id}`,
          metadata: { orderId: order.id, orderStatus: order.status },
          eventKey: `order:placed:${order.id}`,
        },
        db,
      ),
      safeNotify(
        {
          userId: order.vendorId,
          role: 'vendor',
          type: 'new_order',
          title: 'New Incoming Order',
          message: `You received a new order (${order.items.length} item${order.items.length === 1 ? '' : 's'}, $${order.total.toFixed(2)}).`,
          relatedResourceId: order.id,
          link: '/dashboard/vendor/orders',
          metadata: { orderId: order.id, orderStatus: order.status },
          eventKey: `order:new:${order.id}`,
        },
        db,
      ),
    ]),
  );

  return {
    order: serializedOrders[0],
    orders: serializedOrders,
  };
}

export async function listCustomerOrders(customerId, query, db = getDB()) {
  const customerCandidates = buildIdCandidates(customerId);
  const docs = await db
    .collection('orders')
    .find({ customerId: { $in: customerCandidates } }, { projection: SAFE_ORDER_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const serialized = docs.map(serializeOrderForCustomer);
  return filterAndPaginateOrders(serialized, query);
}

export async function getCustomerOrderById({ orderId, customerId }, db = getDB()) {
  const customerCandidates = buildIdCandidates(customerId);
  const doc = await db.collection('orders').findOne(
    {
      $and: [buildObjectIdOrStringFilter(orderId), { customerId: { $in: customerCandidates } }],
    },
    { projection: SAFE_ORDER_PROJECTION },
  );

  if (!doc) {
    throw createAuthHttpError(404, 'Order not found.');
  }

  return serializeOrderForCustomer(doc);
}

export async function cancelCustomerOrder({ orderId, customerId, reason = '' }, db = getDB()) {
  const customerCandidates = buildIdCandidates(customerId);
  const existing = await db.collection('orders').findOne(
    {
      $and: [buildObjectIdOrStringFilter(orderId), { customerId: { $in: customerCandidates } }],
    },
    { projection: SAFE_ORDER_PROJECTION },
  );

  if (!existing) {
    throw createAuthHttpError(404, 'Order not found.');
  }

  if (existing.status !== 'pending') {
    throw createAuthHttpError(
      400,
      'Only orders in Pending status can be cancelled. Once accepted or completed, cancellation is locked.',
    );
  }

  const now = new Date();
  const timelineEntry = {
    previousStatus: 'pending',
    status: 'cancelled',
    timestamp: now,
    actorRole: 'customer',
    actorId: String(customerId),
    note: reason.trim() || 'Cancelled by customer.',
  };

  const updatedDoc = await db.collection('orders').findOneAndUpdate(
    {
      $and: [
        buildObjectIdOrStringFilter(orderId),
        { customerId: { $in: customerCandidates } },
        { status: 'pending' },
      ],
    },
    {
      $set: { status: 'cancelled', updatedAt: now },
      $push: { statusHistory: timelineEntry },
    },
    { returnDocument: 'after', projection: SAFE_ORDER_PROJECTION },
  );

  if (!updatedDoc) {
    throw createAuthHttpError(409, 'Order status changed before cancellation could complete.');
  }

  const cancelledOrder = serializeOrderForCustomer(updatedDoc);

  await Promise.all([
    safeNotify(
      {
        userId: cancelledOrder.customerId,
        role: 'customer',
        type: 'order_cancelled',
        title: 'Order Cancelled',
        message: `Your order with ${cancelledOrder.vendorName} has been cancelled.`,
        relatedResourceId: cancelledOrder.id,
        link: `/dashboard/customer/orders/${cancelledOrder.id}`,
        metadata: { orderId: cancelledOrder.id, orderStatus: 'cancelled' },
        eventKey: `order:cancelled:cust:${cancelledOrder.id}`,
      },
      db,
    ),
    safeNotify(
      {
        userId: cancelledOrder.vendorId,
        role: 'vendor',
        type: 'vendor_order_cancelled',
        title: 'Customer Cancelled Order',
        message: `A customer cancelled pending order #${cancelledOrder.id.slice(-6)}.`,
        relatedResourceId: cancelledOrder.id,
        link: '/dashboard/vendor/orders',
        metadata: { orderId: cancelledOrder.id, orderStatus: 'cancelled' },
        eventKey: `order:cancelled:vend:${cancelledOrder.id}`,
      },
      db,
    ),
  ]);

  return cancelledOrder;
}

export async function listVendorOrders(vendorId, query, db = getDB()) {
  const vendorCandidates = buildIdCandidates(vendorId);
  const docs = await db
    .collection('orders')
    .find({ vendorId: { $in: vendorCandidates } }, { projection: SAFE_ORDER_PROJECTION })
    .sort({ createdAt: -1, _id: -1 })
    .toArray();

  const customerMap = await fetchUsersMapByIds(
    docs.map((doc) => doc.customerId),
    db,
    SAFE_ORDER_CUSTOMER_PROJECTION,
  );
  const serialized = docs.map((doc) =>
    serializeOrderForVendor(doc, customerMap.get(String(doc.customerId ?? ''))),
  );

  return filterAndPaginateOrders(serialized, query);
}

export async function getVendorOrderById({ orderId, vendorId }, db = getDB()) {
  const vendorCandidates = buildIdCandidates(vendorId);
  const doc = await db.collection('orders').findOne(
    {
      $and: [buildObjectIdOrStringFilter(orderId), { vendorId: { $in: vendorCandidates } }],
    },
    { projection: SAFE_ORDER_PROJECTION },
  );

  if (!doc) {
    throw createAuthHttpError(404, 'Order not found.');
  }

  const customerMap = await fetchUsersMapByIds(
    [doc.customerId],
    db,
    SAFE_ORDER_CUSTOMER_PROJECTION,
  );
  return serializeOrderForVendor(doc, customerMap.get(String(doc.customerId ?? '')));
}

export async function updateVendorOrderStatus(
  { orderId, vendorId, targetStatus, note = '' },
  db = getDB(),
) {
  const vendorCandidates = buildIdCandidates(vendorId);
  const existing = await db.collection('orders').findOne(
    {
      $and: [buildObjectIdOrStringFilter(orderId), { vendorId: { $in: vendorCandidates } }],
    },
    { projection: SAFE_ORDER_PROJECTION },
  );

  if (!existing) {
    throw createAuthHttpError(404, 'Order not found.');
  }

  const allowedNext = VENDOR_ORDER_TRANSITIONS[existing.status];
  if (!allowedNext || !allowedNext.has(targetStatus)) {
    throw createAuthHttpError(
      400,
      `Invalid order status transition from "${existing.status}" to "${targetStatus}".`,
    );
  }

  const now = new Date();
  const timelineEntry = {
    previousStatus: existing.status,
    status: targetStatus,
    timestamp: now,
    actorRole: 'vendor',
    actorId: String(vendorId),
    note: note.trim() || defaultNoteForVendorStatus(targetStatus),
  };

  const updatedDoc = await db.collection('orders').findOneAndUpdate(
    {
      $and: [
        buildObjectIdOrStringFilter(orderId),
        { vendorId: { $in: vendorCandidates } },
        { status: existing.status },
      ],
    },
    {
      $set: { status: targetStatus, updatedAt: now },
      $push: { statusHistory: timelineEntry },
    },
    { returnDocument: 'after', projection: SAFE_ORDER_PROJECTION },
  );

  if (!updatedDoc) {
    throw createAuthHttpError(409, 'Order status changed concurrently. Please refresh and retry.');
  }

  const customerMap = await fetchUsersMapByIds(
    [updatedDoc.customerId],
    db,
    SAFE_ORDER_CUSTOMER_PROJECTION,
  );
  const vendorOrder = serializeOrderForVendor(
    updatedDoc,
    customerMap.get(String(updatedDoc.customerId ?? '')),
  );

  const statusLabels = {
    accepted: 'Order Accepted',
    rejected: 'Order Rejected',
    preparing: 'Order Being Prepared',
    ready: 'Order Ready',
  };

  await safeNotify(
    {
      userId: vendorOrder.customerId,
      role: 'customer',
      type: 'order_status',
      title: statusLabels[targetStatus] || 'Order Status Updated',
      message: `${vendorOrder.vendorName} updated your order status to ${targetStatus}.`,
      relatedResourceId: vendorOrder.id,
      link: `/dashboard/customer/orders/${vendorOrder.id}`,
      metadata: { orderId: vendorOrder.id, orderStatus: targetStatus },
      eventKey: `order:status:${vendorOrder.id}:${targetStatus}`,
    },
    db,
  );

  return vendorOrder;
}
