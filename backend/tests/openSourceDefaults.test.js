const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.join(__dirname, "../..");

test("missing business contact does not dial or open an unconfigured map; configured actions still work", () => {
  for (const file of ["pages/home/index.js", "pages/static/about/index.js"]) {
    let page; const calls = [];
    vm.runInNewContext(fs.readFileSync(path.join(root, "miniprogram", file), "utf8"), {
      Page: value => { page = value; },
      require: name => name.endsWith("/business") ? { phone: "", address: "" } : {},
      wx: { makePhoneCall: value => calls.push(["phone", value.phoneNumber]),
        openLocation: value => calls.push(["map", value.address]), showToast() {} }
    });
    const call = page.callBusiness || page.call;
    call.call(page);
    if (page.openLocation) page.openLocation();
    assert.equal(calls.length, 0);
    for (const phone of ["00000000000", "000 0000 0000"]) {
      page.data.business = { phone, address: "" };
      call.call(page);
      assert.equal(calls.length, 0, "public phone placeholder must never dial");
    }
    page.data.business = { phone: "13900000000", address: "虚构测试地址", latitude: 1, longitude: 2 };
    call.call(page);
    assert.deepEqual(calls[0], ["phone", "13900000000"]);
    if (page.openLocation) { page.openLocation(); assert.deepEqual(calls[1], ["map", "虚构测试地址"]); }
  }
});


test("privacy contact rejects missing and sample phones while retaining configured contact action", () => {
  let page; const calls = [], messages = [];
  vm.runInNewContext(fs.readFileSync(path.join(root, "miniprogram/pages/static/privacy/index.js"), "utf8"), {
    Page: value => { page = value; }, require: () => ({}),
    wx: { makePhoneCall: value => calls.push(value.phoneNumber), showToast: value => messages.push(value.title) }
  });
  for (const phone of ["", "00000000000", "000 0000 0000"]) {
    page.data.contactPhone = phone;
    page.contact();
  }
  assert.deepEqual(calls, []);
  assert.equal(messages.length, 3);
  page.data.contactPhone = "13900000000";
  page.contact();
  assert.deepEqual(calls, ["13900000000"]);
});
