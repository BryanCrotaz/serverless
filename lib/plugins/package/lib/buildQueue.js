let lastEntry = null; // a linked list entry or null
let completionMonitor = null; // a promise that resolves when the last entry completes
let completionResolve = null; // function that resolves completionMonitor

module.exports = {
  async sequentialExecute(fn) {
    let nextEntry = {
      next: null,
      fn
    }
    if (lastEntry != null) {
      // add this fn on the end of the chain to be executed sequentially
      lastEntry.next = nextEntry;
      lastEntry = nextEntry;
      await completionMonitor;
    }
    else 
    {
      // start a new chain
      completionMonitor = new Promise(resolve => completionResolve = resolve);
      lastEntry = nextEntry;
      currentEntry = lastEntry; // which is actually the first entry
      do {
        await currentEntry.fn();
        currentEntry = currentEntry.next;
      } while (currentEntry != null)
      completionResolve();
      completionMonitor = null;
    }
  }
}