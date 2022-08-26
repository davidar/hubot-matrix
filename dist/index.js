
'use strict'

if (process.env.NODE_ENV === 'production') {
  module.exports = require('./matrix.cjs.production.min.js')
} else {
  module.exports = require('./matrix.cjs.development.js')
}
