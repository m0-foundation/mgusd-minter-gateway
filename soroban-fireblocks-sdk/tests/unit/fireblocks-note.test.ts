import { buildFireblocksNote } from "../../src/fireblocks-note";

const CONTRACT = "CBTBECF23HVNN4CEWBYOV544FIUTN3LSPCYRBSIAOJDICRBGTCGBAATN";
const CALLER = "GD4KTM3SWERNNEPHCFWR2J4Q2VM6UUN54HYVLO6AEQTUSS7HCMDK5BRP";
const USER = "GADV2Q7MVEVOJ7C5QK4P6IN6H5MPMTSM3YPG5IDAJ7ZMXQTNCLUIUJRE";

describe("buildFireblocksNote", () => {
  it("formats a single-arg call with method, args, contract, and caller", () => {
    const note = buildFireblocksNote({
      protocol: "mintergateway",
      method: "block_user",
      contract: CONTRACT,
      caller: CALLER,
      args: { user: USER },
    });

    expect(note).toContain("mintergateway::block_user");
    expect(note).toContain(`user: ${USER}`);
    expect(note).toContain(`contract: ${CONTRACT}`);
    expect(note).toContain(`caller:   ${CALLER}`);
  });

  it("omits the args block when no args are provided", () => {
    const note = buildFireblocksNote({
      protocol: "mintergateway",
      method: "pause",
      contract: CONTRACT,
      caller: CALLER,
    });

    expect(note).toContain("mintergateway::pause");
    expect(note).toContain(`contract: ${CONTRACT}`);
    expect(note).not.toContain("user:");
  });

  it("renders bigint args as decimal strings (i128 amounts)", () => {
    const note = buildFireblocksNote({
      protocol: "mintergateway",
      method: "mint",
      contract: CONTRACT,
      caller: CALLER,
      args: { to: USER, amount: 1234567890123456789n },
    });

    expect(note).toContain("amount: 1234567890123456789");
  });

  it("truncates with ellipsis when over the 250-char Fireblocks limit", () => {
    // Construct args that blow past the cap.
    const longValue = "X".repeat(500);
    const note = buildFireblocksNote({
      protocol: "mintergateway",
      method: "block_user",
      contract: CONTRACT,
      caller: CALLER,
      args: { huge: longValue },
    });

    expect(note.length).toBeLessThanOrEqual(250);
    expect(note.endsWith("...")).toBe(true);
    expect(note.startsWith("mintergateway::block_user")).toBe(true);
  });
});
