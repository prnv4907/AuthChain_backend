import jwt from "jsonwebtoken";
import express, { Router } from "express";
import {
  EventCheck,
  LoginCheck,
  ProdutCheck,
  SighnupCheck,
} from "../middlewar/TypesMiddleware.js";
import "dotenv/config";
import bcrypt from "bcrypt";
import { PrismaClient } from "@prisma/client";
import { TokenCheck } from "../middlewar/TokenMiddleware.js";
import {
  PublicKey,
  Connection,
  clusterApiUrl,
  Keypair,
  Transaction,
  SystemProgram,
} from "@solana/web3.js";
import anchor from "@coral-xyz/anchor";
import idl from "../idl/auth_chain_contract.json" with { type: "json" };
import { eventMiddleware } from "../middlewar/eventMiddleware.js";
if (!process.env.JWT_SECRET) {
  throw new Error("Fatal error: jwt secret is not defined");
}
const jwtSecret = process.env.JWT_SECRET;
const userRouter: Router = express();
const prisma = new PrismaClient();
const connection = new Connection(clusterApiUrl("devnet"), "confirmed");
const serverKey = process.env.SOLANA_PRIVATE_KEY as string;
const serverKeypair = Keypair.fromSecretKey(
  new Uint8Array(JSON.parse(serverKey)),
);
const provider = new anchor.AnchorProvider(
  connection,
  new anchor.Wallet(serverKeypair),
  { preflightCommitment: "confirmed" },
);
anchor.setProvider(provider);
const programId = new PublicKey(idl.address);
const program = new anchor.Program(idl, provider);
if (!program) {
  throw new Error(
    "fatal: anchor program could not be initialized. Check your rpc, idl and provider",
  );
}

console.log(
  `program loaded successfully, Program Id:${program.programId.toBase58()}`,
);

userRouter.post("/signUp", SighnupCheck, async (req, res) => {
  const { username, firstName, lastName, email, password, account } = req.body;
  console.log(req.body.username);
  const isSuccess = await prisma.user.findUnique({
    where: {
      email: email,
    },
  });
  if (isSuccess) {
    res.status(409).json({
      message: "email already exists",
    });
  }
  const hashedPassword = await bcrypt.hash(password, 10);

  const success = await prisma.user.create({
    data: {
      username: username,
      email: email,
      password: hashedPassword,
      firstName: firstName,
      lastName: lastName,
      account: account,
    },
  });
  res.status(200).json({
    message: "user created",
  });
});
userRouter.post("/login", LoginCheck, async (req, res) => {
  const { username, password } = req.body;
  const user = await prisma.user.findFirst({
    where: {
      username,
    },
  });
  if (!user) {
    res.status(401).json({
      message: "incorrect credentials",
    });
    return;
  }
  try {
    const success = await bcrypt.compare(password, user.password);
    if (!success) {
      res.status(401).json({
        message: "incorrect credentials",
      });
    }
    const payload = {
      userId: user.id,
    };

    const token = jwt.sign(payload, jwtSecret);
    res.cookie("authToken", token, {
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 3600000,
    });
    res.status(200).json({
      message: "Logged in successfully",
    });
  } catch (err) {
    res.status(500).json("unable to log in");
  }
});
userRouter.post(
  "/registerProduct",
  ProdutCheck,
  TokenCheck,
  async (req, res) => {
    if (!req.userId) {
      res.status(500).json({
        message: "not being able to save userId",
      });
      return;
    }
    const userId = req.userId;
    console.log(userId);
    if (!userId) {
      res.status(401).json({
        message: "invalid userId",
      });
    }
    const modelNo = req.body.modelNo;
    const IsFound = await prisma.product.findUnique({
      where: {
        modelNo: modelNo,
      },
    });
    if (IsFound != null) {
      res.status(409).json({
        message: "product already registered",
      });
    }

    try {
      const seeds = [
        Buffer.from("auth"),
        new anchor.BN(modelNo).toArrayLike(Buffer, "le", 8),
      ];
      const [pdaAccount] = PublicKey.findProgramAddressSync(
        seeds,
        program.programId,
      );
      const user = await prisma.user.findUnique({
        where: {
          id: userId,
        },
      });
      if (!user || !user.account) {
        res.status(500).json({
          message: "unable to fetch user details",
        });
        return;
      }

      const userPublickey = user.account;
      const tx = await program.methods.initialize!(new anchor.BN(modelNo))
        .accounts({
          signer: new PublicKey(userPublickey),
          pdaAccount: pdaAccount,
          systemProgram: SystemProgram.programId,
        })
        .transaction();
      tx.feePayer = new PublicKey(userPublickey);
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      const serializeTransaction = tx.serialize({
        requireAllSignatures: false,
      });
      const transactionBase64 = serializeTransaction.toString("base64");
      const product = await prisma.product.create({
        data: {
          name: req.body.name,
          modelNo: req.body.modelNo,
          pdaAccount: JSON.stringify(pdaAccount),
          owner: {
            connect: {
              id: userId,
            },
          },
        },
      });
      res.status(200).json({
        transaction: transactionBase64,
      });
    } catch (err) {
      console.error(err);
      const errorMessage =
        err instanceof Error ? err.message : "An unknown error occred";
      res.status(500).json({
        error: "failed to build initialize transaction",
        details: errorMessage,
      });
    }
  },
);

userRouter.post("/event", eventMiddleware, EventCheck, async (req, res) => {
  const toAccount: string = req.body.toAccount;
  const fromAccount: string = req.body.fromAccount;
  const productAccount: string = req.body.productAccount;
  const signature: string = req.body.signature;
  const type: string = req.body.type;
  const product = await prisma.product.findUnique({
    where: {
      pdaAccount: productAccount,
    },
  });
  if (!product) {
    res.status(500).json({
      message: "indexing error",
    });
    return;
  }
  try {
    const productId = product.id;
    const Event = await prisma.event.create({
      data: {
        fromAccount: fromAccount,
        date: new Date(),
        toAccount: toAccount,
        signature: signature,
        type: type,
        productId: productId,
      },
    });
    res.json(200);
  } catch (err) {
    res.status(500).json({
      message: "unable to create the database entry",
    });
  }
});

userRouter.post("/transfer", TokenCheck, async (req, res) => {
  const { fromAccount, toAccount, productId } = req.body;
  const product = await prisma.product.findUnique({
    where: {
      id: productId,
    },
  });
  if (!product) {
    res.status(400).json({
      message: "invalid product id",
    });
    return;
  }
  try {
    if (!program) {
      throw new Error("Blockchain program is not initialized.");
    }
    const fromAddress = new PublicKey(fromAccount);
    const toAddress = new PublicKey(toAccount);
    const productAddress = new PublicKey(product.pdaAccount);

    const tx: Transaction = await program.methods.transfer!(
      product.modelNo,
      toAddress,
    )
      .accounts({
        signer: new PublicKey(fromAddress),
        pdaAccount: productAddress,
        systemProgram: SystemProgram.programId,
      })
      .transaction();
    tx.feePayer = fromAddress;
    tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
    const serializedTransaction = tx.serialize({
      requireAllSignatures: false,
    });
    const transactionBase64 = serializedTransaction.toString("base64");
    res.status(200).json({
      transaction: transactionBase64,
    });
  } catch (err) {
    res.status(500).json({
      message: "internal error in transferring",
    });
  }
});

userRouter.get("/initializedProducts", TokenCheck, async (req, res) => {
  const userId = req.userId;
  if (!userId) {
    res.status(500).json({
      message: "unable to append userId",
    });
  }
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    include: {
      products: true,
    },
  });
  if (user == null) {
    res.status(404).json({
      message: "user not found",
    });
    return;
  }
  res.status(200).json(user.products);
});

export default userRouter;
