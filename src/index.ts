import express from "express";
import userRouter from "./routes/userRoute.js";
import cookieParser from "cookie-parser";
const app = express();
app.use(express.json());
app.use(cookieParser());
app.use("/api/", userRouter);
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("server running at port", PORT);
});
