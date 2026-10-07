(function () {
  'use strict';
  let database;
  function open() {
    if (database) return database;
    database = new Promise((resolve, reject) => {
      const request = indexedDB.open('dcc-device-alarms-v1', 1);
      request.onupgradeneeded = () => request.result.createObjectStore('state');
      request.onsuccess = () => { request.result.onversionchange = () => request.result.close(); resolve(request.result); };
      request.onerror = () => reject(request.error);
      request.onblocked = () => reject(Error('Alarm storage is blocked by another tab.'));
    });
    return database;
  }
  async function transact(change) {
    const db = await open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('state', change ? 'readwrite' : 'readonly');
      const store = tx.objectStore('state');
      const request = store.get('device');
      let result, error;
      request.onsuccess = () => {
        try {
          result = DCCAlarmModel.restore(request.result, Date.now());
          if (change) { change(result); DCCAlarmModel.restore(result, Date.now()); store.put(result, 'device'); }
        } catch (e) { error = e; tx.abort(); }
      };
      tx.oncomplete = () => resolve(result);
      tx.onabort = tx.onerror = () => reject(error || tx.error || Error('Local save failed.'));
    });
  }
  window.DCCAlarmStore = { transact };
})();
