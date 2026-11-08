const request = require('../utils/request');
module.exports = {
  summary: () => request({ url: '/api/appointment-inbox' }),
  acknowledge: (viewId, entries) => request({ url: '/api/appointment-inbox/read', method: 'POST', data: { viewId, entries } })
};
