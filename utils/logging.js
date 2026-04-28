const util = require('util');

function safeSerialize(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (value === undefined) {
    return null;
  }

  return value;
}

function stringifyLog(value) {
  if (typeof value === 'string') {
    return value;
  }

  try {
    return JSON.stringify(safeSerialize(value));
  } catch (error) {
    return util.format('%o', value);
  }
}

function logJson(prefix, value) {
  console.log(prefix, stringifyLog(value));
}

function warnJson(prefix, value) {
  console.warn(prefix, stringifyLog(value));
}

function errorJson(prefix, value) {
  console.error(prefix, stringifyLog(value));
}

module.exports = {
  errorJson,
  logJson,
  safeSerialize,
  stringifyLog,
  warnJson,
};
