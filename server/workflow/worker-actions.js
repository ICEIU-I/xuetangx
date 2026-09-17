const { createClient } = require('./workers/common');
const { createMedia } = require('./workers/media');
const { createHomework } = require('./workers/homework');
const { createCollector } = require('./workers/collector');
function createWorkerActions(options) {
  const context = { subscribe: () => () => {}, ...options, ...createClient(options) };
  const media = createMedia(context), homework = createHomework(context), collector = createCollector(context);
  return { run: input => input.kind === 'homework' ? homework(input) : input.kind === 'collector' ? collector(input) : media(input) };
}
module.exports = { createWorkerActions };
