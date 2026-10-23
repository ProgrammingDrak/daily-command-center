/* Shared, bounded condition algebra. No DOM or database dependencies. */
(function(root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else { root.DCC = root.DCC || {}; root.DCC.RewardConditions = factory(); }
})(typeof globalThis !== 'undefined' ? globalThis : this, function() {
  const MAX_NODES = 256;
  function invalid(message) { const e = new Error(message); e.statusCode = 400; return e; }
  // Iterative traversal bounds work by total nodes, not by an arbitrary UI depth.
  function normalize(input, resolveTask = id => ({ taskId: id })) {
    const seen = new Set(), tasks = new Set(), holder = {};
    const stack = [{ node: input, parent: holder, key: 'root' }];
    let count = 0;
    while (stack.length) {
      const { node, parent, key } = stack.pop();
      if (++count > MAX_NODES) throw invalid('Use at most 256 conditions per reward');
      if (!node || typeof node !== 'object' || Array.isArray(node) || seen.has(node)) throw invalid('Conditions must be a tree without cycles');
      seen.add(node);
      if (node.type === 'task') {
        if (typeof node.taskId !== 'string' || !node.taskId.trim() || node.taskId.length > 200) throw invalid('Choose a task for every condition');
        const task = resolveTask(node.taskId);
        if (!task) throw invalid('A selected task is unavailable on this shared list');
        const identity = String(task.blockId || task.taskId);
        if (tasks.has(identity)) throw invalid('Each task can appear only once in a reward');
        tasks.add(identity);
        parent[key] = { type: 'task', ...task };
      } else {
        if (node.type !== 'group' || !['all', 'any'].includes(node.op)) throw invalid('Choose ALL or ANY for each group');
        if (!Array.isArray(node.children) || !node.children.length) throw invalid('Every group needs at least one task or group');
        if (node.children.length + count > MAX_NODES) throw invalid('Use at most 256 conditions per reward');
        const out = { type: 'group', op: node.op, children: [] }; parent[key] = out;
        for (let i = node.children.length - 1; i >= 0; i--) stack.push({ node: node.children[i], parent: out.children, key: i });
      }
    }
    return holder.root;
  }
  function leaves(root) {
    const result = [], stack = [root];
    while (stack.length) { const node = stack.pop(); if (node.type === 'task') result.push(node); else stack.push(...node.children); }
    return result;
  }
  function evaluate(root, isDone) {
    const values = new Map(), stack = [[root, false]];
    while (stack.length) {
      const [node, visited] = stack.pop();
      if (node.type === 'task') values.set(node, isDone(node) === true);
      else if (!visited) { stack.push([node, true]); for (const child of node.children) stack.push([child, false]); }
      else values.set(node, node.children.length > 0 && (node.op === 'all' ? node.children.every(c => values.get(c)) : node.children.some(c => values.get(c))));
    }
    return values.get(root) === true;
  }
  function describe(root, title = node => node.title || node.taskId) {
    const out = [], stack = [root];
    while (stack.length) {
      const node = stack.pop();
      if (typeof node === 'string') { out.push(node); continue; }
      if (node.type === 'task') out.push(title(node));
      else { out.push(node.op.toUpperCase() + ' ('); stack.push(')'); for (let i = node.children.length - 1; i >= 0; i--) { stack.push(node.children[i]); if (i) stack.push('; '); } }
    }
    return out.join('');
  }
  return { MAX_NODES, normalize, leaves, evaluate, describe };
});
