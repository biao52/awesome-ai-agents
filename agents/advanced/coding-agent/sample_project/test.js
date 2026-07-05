/**
 * Simple test runner for the Todo API.
 * Tests basic CRUD operations.
 */

const BASE = "http://localhost:3000";

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (e) {
    console.log(`  ✗ ${name}: ${e.message}`);
    failed++;
  }
}

function assert(condition, message) {
  if (!condition) throw new Error(message || "Assertion failed");
}

async function run() {
  console.log("Running Todo API tests...\n");

  await test("POST /todos creates a todo", async () => {
    const res = await fetch(`${BASE}/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: "Buy groceries" }),
    });
    assert(res.status === 201, `Expected 201, got ${res.status}`);
    const todo = await res.json();
    assert(todo.title === "Buy groceries", "Title mismatch");
    assert(todo.completed === false, "Should not be completed");
    assert(typeof todo.id === "number", "ID should be a number");
  });

  await test("GET /todos returns all todos", async () => {
    const res = await fetch(`${BASE}/todos`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const todos = await res.json();
    assert(Array.isArray(todos), "Should be an array");
    assert(todos.length >= 1, "Should have at least 1 todo");
  });

  await test("GET /todos/:id returns a specific todo", async () => {
    const res = await fetch(`${BASE}/todos/1`);
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const todo = await res.json();
    assert(todo.id === 1, "ID should be 1");
  });

  await test("GET /todos/:id returns 404 for missing todo", async () => {
    const res = await fetch(`${BASE}/todos/999`);
    assert(res.status === 404, `Expected 404, got ${res.status}`);
  });

  await test("PATCH /todos/:id updates a todo", async () => {
    const res = await fetch(`${BASE}/todos/1`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ completed: true }),
    });
    assert(res.status === 200, `Expected 200, got ${res.status}`);
    const todo = await res.json();
    assert(todo.completed === true, "Should be completed");
  });

  await test("DELETE /todos/:id removes a todo", async () => {
    const res = await fetch(`${BASE}/todos/1`, { method: "DELETE" });
    assert(res.status === 204, `Expected 204, got ${res.status}`);
    const check = await fetch(`${BASE}/todos/1`);
    assert(check.status === 404, "Deleted todo should return 404");
  });

  await test("POST /todos without title returns 400", async () => {
    const res = await fetch(`${BASE}/todos`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    assert(res.status === 400, `Expected 400, got ${res.status}`);
  });

  console.log(`\nResults: ${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

run().catch((e) => {
  console.error(`Test runner error: ${e.message}`);
  process.exit(1);
});
