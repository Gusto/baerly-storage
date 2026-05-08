import { expect, test, describe } from "bun:test";
import {
  CentralisedCausalSystem,
  CentralisedOfflineFirstCausalSystem,
  check,
  toJS,
  union,
} from "./consistency";
describe("check", () => {
  test("check (true)", () => {
    const result = check(
      {
        a: 0,
        b: 1,
      },
      {
        "a < b": null,
      },
    );
    expect(result).toBe(true);
  });

  test("check (false)", () => {
    const result = check(
      {
        a: 1,
        b: 0,
      },
      {
        "a < b": null,
      },
    );
    expect(result).toBe(false);
  });

  test("check clauses are added (true)", () => {
    const result = check(
      {
        a: 0,
        b: 1,
        c: 2,
      },
      {
        "a < b": null,
        "b < c": null,
      },
    );
    expect(result).toBe(true);
  });
  test("check clauses are added (false)", () => {
    const result = check(
      {
        a: 2,
        b: 1,
        c: 0,
      },
      {
        "a < b": null,
        "b < c": null,
      },
    );
    expect(result).toBe(false);
  });
});

describe("union", () => {
  test("union combined unique clauses", () => {
    const a = {
      "a < b": null,
    };
    const b = {
      "b < c": null,
    };
    const c = union(a, b);

    expect(c).toEqual({
      "a < b": null,
      "b < c": null,
    });
    expect(a).toEqual({
      "a < b": null,
    });
    expect(b).toEqual({
      "b < c": null,
    });
  });

  test("union deduplicates identical clauses", () => {
    const a = {
      "a < b": null,
    };
    const b = {
      "a < b": null,
    };
    const c = union(a, b);

    expect(c).toEqual({
      "a < b": null,
    });
  });
});

describe("CausalSystem", () => {
  test("Alice, Bob and Carol compact example, exclude reordering", () => {
    const system = new CentralisedCausalSystem();
    const alice = 0,
      bob = 1,
      carol = 2;

    system.observe({ receiver: carol, sender: bob, send_time: 0 }); // carol received bobs question
    expect(system.causallyConsistent()).toBe(true);

    system.observe({ receiver: alice, sender: carol, send_time: 1 }); // alice hears carols reply
    expect(system.causallyConsistent()).toBe(true);

    // Causal consistency violation
    system.observe({ receiver: alice, sender: bob, send_time: 0 });
    expect(system.causallyConsistent()).toBe(false); // alice hears bob's question after the reply
  });

  test("Alice, Bob and Carol full example", () => {
    const system = new CentralisedCausalSystem();
    const alice = 0,
      bob = 1,
      carol = 2;

    system.observe({ receiver: bob, sender: bob, send_time: 0 }); // bob writes a message
    console.log(toJS(system.grounding, system.knowledge_base));
    system.observe({ receiver: carol, sender: bob, send_time: 1 }); // carol received bobs question
    console.log(toJS(system.grounding, system.knowledge_base));
    expect(system.causallyConsistent()).toBe(true);
    expect(system.client_clocks).toEqual([1, 2, 2]);
    system.observe({ receiver: carol, sender: carol, send_time: 1 }); // carol writes a message
    console.log(toJS(system.grounding, system.knowledge_base));
    expect(system.causallyConsistent()).toBe(true);
    system.observe({ receiver: alice, sender: carol, send_time: 2 }); // alice hears carols reply
    console.log(toJS(system.grounding, system.knowledge_base));
    expect(system.causallyConsistent()).toBe(true);
    expect(system.client_clocks).toEqual([2, 2, 3]);

    // violation, carol observes bob's message after carol's message that was a
    // reply to bob
    system.observe({ receiver: alice, sender: bob, send_time: 1 });
    console.log(toJS(system.grounding, system.knowledge_base));
    expect(system.causallyConsistent()).toBe(false); // alice hears bob's question
  });
});

describe("Offline-first causal system", () => {
  test("Carol offline-sync", () => {
    const system = new CentralisedOfflineFirstCausalSystem();
    const alice = 0,
      bob = 1,
      carol = 2; // carol is offline

    // carol is offline
    system.observe({ receiver: carol, sender: carol, send_time: 0 }); // carol writes to herself
    expect(system.causallyConsistent()).toBe(true);

    // online conversation between alice and bob
    system.observe({ receiver: bob, sender: alice, send_time: 0 }); // bob send to alice
    expect(system.causallyConsistent()).toBe(true);
    system.observe({ receiver: alice, sender: bob, send_time: 1 }); // alice replies
    expect(system.causallyConsistent()).toBe(true);

    // carol comes online
    system.observe({ receiver: carol, sender: carol, send_time: 1 }); // carol writes to herself
    expect(system.causallyConsistent()).toBe(true);
    system.observe({ receiver: carol, sender: alice, send_time: 0 }); // carol catches up
    expect(system.causallyConsistent()).toBe(true);
    system.observe({ receiver: carol, sender: bob, send_time: 1 }); // carol catches up
    expect(system.causallyConsistent()).toBe(true);

    // bob & alice receives carols offline seconds message
    system.observe({ receiver: bob, sender: carol, send_time: 1 });
    expect(system.causallyConsistent()).toBe(true);
    system.observe({ receiver: alice, sender: carol, send_time: 1 });
    expect(system.causallyConsistent()).toBe(true);

    // bob receives carols seconds message, this is out-of-order!
    system.observe({ receiver: bob, sender: carol, send_time: 0 });
    expect(system.causallyConsistent()).toBe(false);
  });
});
