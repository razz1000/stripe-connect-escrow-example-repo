// Minimal JSON-file persistence. Replace with a real database in production.
const fs = require('fs');
const path = require('path');

const FILE = path.join(__dirname, 'data.json');

function load() {
  if (!fs.existsSync(FILE)) return { sellers: {}, orders: {} };
  return JSON.parse(fs.readFileSync(FILE, 'utf8'));
}

function save(data) {
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

module.exports = {
  upsertSeller(seller) {
    const data = load();
    data.sellers[seller.id] = { ...(data.sellers[seller.id] || {}), ...seller };
    save(data);
    return data.sellers[seller.id];
  },
  getSeller(id) {
    return load().sellers[id] || null;
  },
  upsertOrder(order) {
    const data = load();
    data.orders[order.id] = { ...(data.orders[order.id] || {}), ...order };
    save(data);
    return data.orders[order.id];
  },
  getOrder(id) {
    return load().orders[id] || null;
  },
  listOrders() {
    return Object.values(load().orders);
  },
};
