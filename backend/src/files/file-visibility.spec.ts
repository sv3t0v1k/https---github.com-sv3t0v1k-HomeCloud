import { NotFoundException } from "@nestjs/common";
import { EntityManager } from "typeorm";
import { assertVisibleAncestors } from "./file-visibility";

describe("Shared file ancestor visibility", () => {
  const query = jest.fn();
  const manager = { query } as unknown as EntityManager;

  beforeEach(() => jest.resetAllMocks());

  it("allows a root-level file without querying ancestors", async () => {
    await expect(assertVisibleAncestors(manager, 1, null))
      .resolves.toBeUndefined();
    expect(query).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "rejects malformed parent ID %s",
    async (parentId) => {
      await expect(assertVisibleAncestors(manager, 1, parentId))
        .rejects.toBeInstanceOf(NotFoundException);
      expect(query).not.toHaveBeenCalled();
    },
  );

  it("requires active ancestors and correctly matched mirrors", async () => {
    query.mockResolvedValueOnce([{ visible: true }]);

    await expect(assertVisibleAncestors(manager, 7, 42))
      .resolves.toBeUndefined();

    expect(query).toHaveBeenCalledTimes(1);
    expect(query.mock.calls[0][0]).toContain("WITH RECURSIVE ancestor_chain");
    expect(query.mock.calls[0][0]).toContain('NOT chain."isDeleted"');
    expect(query.mock.calls[0][0]).toContain('NOT mirror."isDeleted"');
    expect(query.mock.calls[0][0]).toContain("NOT chain.cycle");
    expect(query.mock.calls[0][1]).toEqual([7, 42]);
  });

  it.each([
    { name: "missing rows", rows: [] },
    { name: "invisible ancestors", rows: [{ visible: false }] },
    { name: "NULL visibility", rows: [{ visible: null }] },
  ])("fails closed for $name", async ({ rows }) => {
    query.mockResolvedValueOnce(rows);

    await expect(assertVisibleAncestors(manager, 7, 42))
      .rejects.toBeInstanceOf(NotFoundException);
  });
});
