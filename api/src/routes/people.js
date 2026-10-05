import { Router } from "express";
import { asyncRoute, HttpError } from "../lib/errors.js";
import { requireAuth } from "../middleware/auth.js";
import { mergeFaces } from "../services/ml.js";
import { assertOwnPeople, facesLock, listPeople, mergePeople, updatePerson } from "../services/people.js";
import { bumpGen, withLock } from "../lib/redis.js";

const router = Router();
const uuid = (v) => typeof v === "string" && /^[0-9a-f-]{36}$/i.test(v);
const forgetSearchContext = (userId) => bumpGen(`omni:searchctx:${userId}`);

router.get(
  "/people",
  requireAuth,
  asyncRoute(async (req, res) =>
    res.json({ people: await listPeople(req.user.id, { includeSingles: req.query.all === "1", hidden: req.query.hidden === "1" }) })
  )
);

router.patch(
  "/people/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (!uuid(req.params.id)) throw new HttpError(400, "Bad person id.");
    const body = req.body ?? {};
    await updatePerson(req.user.id, req.params.id, {
      ...("name" in body && { name: body.name }),
      ...("hidden" in body && { hidden: Boolean(body.hidden) }),
    });
    await forgetSearchContext(req.user.id);
    res.json({ ok: true });
  })
);

// Merge other clusters into this person (same human split into several clusters).
router.post(
  "/people/:id/merge",
  requireAuth,
  asyncRoute(async (req, res) => {
    const target = req.params.id;
    const sources = Array.isArray(req.body?.sources) ? req.body.sources.filter(uuid).slice(0, 50) : [];
    if (!uuid(target) || !sources.length) throw new HttpError(400, "Pick at least one person to merge.");
    // Validate before touching anything, so a bad request can't change the face index alone.
    await assertOwnPeople(req.user.id, [target, ...sources]);
    // Same lock as face clustering: no face can be assigned to a source mid-merge. Face index
    // first, so future faces of the merged clusters keep landing on the target.
    const merged = await withLock(facesLock(req.user.id), async () => {
      await mergeFaces({ userId: req.user.id, sources, target });
      return mergePeople(req.user.id, target, sources);
    });
    await forgetSearchContext(req.user.id);
    res.json({ ok: true, merged: merged.length });
  })
);

export default router;
