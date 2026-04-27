import { Router, type IRouter } from "express";
import healthRouter from "./health";
import isoRouter from "./iso";

const router: IRouter = Router();

router.use(healthRouter);
router.use(isoRouter);

export default router;
