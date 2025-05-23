import { Request, Response } from "express";

import catchAsync from "../../utils/catchAsync";
import sendError from "../../utils/sendError";
import sendResponse from "../../utils/sendResponse";

import {
  createUser,
  getUserList,
  registerUserService,
  updateUserById,
  userDelete,
  verifyOTPService,
} from "./user.service";

import { OTPModel, UserModel } from "./user.model";

import { emitNotification } from "../../utils/socket";
import httpStatus from "http-status";
// import RegisterShowerModel from "../RegisterShower/RegisterShower.model";

import argon2 from "argon2";

import {
  findUserByEmail,
  findUserById,
  generateOTP,
  hashPassword,
  resendOTPEmail,
  saveOTP,
  sendManagerRequest,
  sendOTPEmailRegister,
  sendOTPEmailVerification,
  sendResetOTPEmail,
} from "./user.utils";

import ApiError from "../../errors/ApiError";
import {
  generateRegisterToken,
  generateToken,
  verifyToken,
} from "../../utils/JwtToken";
import mongoose from "mongoose";

import { sendPushNotification } from "../notifications/pushNotification/pushNotification.controller";
import { IUserPayload } from "../../middlewares/roleGuard";
import { validateUserLockStatus } from "../../middlewares/lock";

export const registerUser = catchAsync(async (req: Request, res: Response) => {
  const { name, email, password, fcmToken } = req.body;
  // Validate that the role is provided; if not, throw an error.
  // Call the service to register the user, which returns an OTP.
  const { otp } = await registerUserService(name, email, password);
  // Generate a token for the registration process.
  const token = generateRegisterToken({ email });
  // Immediately send a response back to the client.
  // This reduces the API response time.
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "OTP sent to your email. Please verify to continue registration.",
    data: { token: token },
  });

  // Offload the remaining operations to a background asynchronous block.
  (async () => {
    try {
      // Send the OTP email in the background.
      await sendOTPEmailRegister(name, email, otp);
      // Hash the provided password.
      const hashedPassword = await hashPassword(password);
      let image: any = {
        path: "",
        publicFileURL: "",
      };
      if (req.file) {
        const imagePath = `public\\images\\${req.file.filename}`;
        const publicFileURL = `/images/${req.file.filename}`;
        image = {
          path: imagePath,
          publicFileURL: publicFileURL,
        };
      }
      // Create a new user account with the hashed password and other details.
      const { createdUser } = await createUser({
        name,
        email,
        image,
        hashedPassword,
        fcmToken,
      });

      // Calculate OTP expiration (60 seconds from now)
      const now = new Date();
      const expiresAt = new Date(now.getTime() + 60 * 1000);
      // Save or update the OTP in the database concurrently.
      await Promise.all([
        OTPModel.findOneAndUpdate(
          { email },
          { otp, expiresAt },
          { upsert: true }
        ),
        saveOTP(email, otp),
      ]);

      // --------> Emit notification <----------------
      // Convert the created user's id to a mongoose ObjectId type.
      const userObjectId = new mongoose.Types.ObjectId(
        createdUser._id as string
      );
      // Create a payload for notifications with messages for both the user and the admin.
      const notificationPayload: any = {
        userId: userObjectId,
        userMsg: `💫 Welcome to Bienvenue, ${createdUser.name}! 🎉 Your registration is complete, and we're thrilled to have you onboard. Start exploring and enjoy the experience! 🚀`,
        adminMsg: `📢 New user registration! 🎉 A new user, ${createdUser.name}, has successfully registered with Bienvenue. Please welcome them aboard and ensure everything is set up for their journey.`,
      };

      // Emit the notification.
      await emitNotification(notificationPayload);
      // --------> End Emit notification <----------------
      // --------> Send push notification via FCM (if fcmToken is provided) <----------------
      if (fcmToken) {
        try {
          // Define the base push message.
          const pushMessage = {
            title: "🎉 Welcome to Sweepy!",
            body: `Hi ${name}, 🎉 Welcome to Bienvenue! Your registration is complete. We're excited to have you onboard!`,
          };

          // Customize message for a manager role.
          if (createdUser.role === "manager") {
            pushMessage.body = `💼 Welcome to Bienvenue, ${name}! 🎉 Your registration is complete! Our team will review your account shortly for approval as a manager. Thank you for your patience! ✅`;
          }

          // Send the push notification.
          await sendPushNotification(fcmToken, pushMessage);
        } catch (pushError) {
          // Log any push notification errors without affecting the client response.
          console.error("Error sending push notification:", pushError);
        }
      }
      // --------> End push notification <----------------
    } catch (backgroundError) {
      // Log errors from background tasks so they don't affect the already sent response.
      console.error("Error in background tasks:", backgroundError);
    }
  })();
});

export const resendOTP = catchAsync(async (req: Request, res: Response) => {
  let decoded;
  try {
    decoded = verifyToken(req.headers.authorization as string);
  } catch (error: any) {
    throw new ApiError(httpStatus.UNAUTHORIZED, "Invalid token");
  }
  const email = decoded.email as string;
  const now = new Date();
  const otpRecord = await OTPModel.findOne({ email });

  if (otpRecord && otpRecord.expiresAt > now) {
    const remainingTime = Math.floor(
      (otpRecord.expiresAt.getTime() - now.getTime()) / 1000
    );

    throw new ApiError(
      httpStatus.FORBIDDEN,
      `You can't request another OTP before ${remainingTime} seconds.`
    );
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "A new OTP has been sent to your email.",
    data: null,
  });
  const otp = generateOTP();
  // await setCache(email, otp, 300);

  // await resendOTPEmail(email, newOTP);
  // const user = await UserModel.findOne({ email });
  // Attempt to send the email
  resendOTPEmail(email, otp)
    .then((res) => {
      console.log("Email Send");
    })
    .catch((err) => {
      console.log("Email not send");
    });
  await saveOTP(email, otp); // Save the new OTP with expiration
});

export const loginUser = catchAsync(async (req: Request, res: Response) => {
  const { email, password, role, fcmToken } = req.body;

  const user = await findUserByEmail(email);

  if (!user) {
    throw new ApiError(404, "This account does not exist.");
  }

  if (user.isDeleted) {
    throw new ApiError(404, "your account is deleted.");
  }
  await validateUserLockStatus(user);
  const userId = user._id as string;
  const token = generateToken({
    id: userId,
    email: user.email,
    role: user.role,
  });

  if (!user.isVerified) {
    sendResponse(res, {
      statusCode: 401,
      success: false,
      message: "We've sent an OTP to your email to verify your profile.",
      data: {
        role: user.role,
        token,
      },
    });
    const name = user.name as string;
    const otp = generateOTP();
    sendOTPEmailVerification(name, email, otp)
      .then(() => {
        console.log("Email sent");
      })
      .catch((err) => {
        console.error("Error sending OTP email:", err);
      });
    return await saveOTP(email, otp);
  }
  const isPasswordValid = await argon2.verify(
    user.password as string,
    password
  );
  if (!isPasswordValid) {
    throw new ApiError(401, "Wrong password!");
  }

  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Login complete!",
    data: {
      user: {
        _id: user._id,
        name: user?.name,
        email: user?.email,
        image: user?.image?.publicFileURL || "",
        role: user?.role,
        profile_status: user?.profile_status,
      },
      token,
    },
  });

  user.fcmToken = fcmToken;
  await user.save();
});

//cool down timer
export const forgotPassword = catchAsync(
  async (req: Request, res: Response) => {
    const { email } = req.body;

    if (!email) {
      throw new ApiError(400, "Please provide an email.");
    }
    // await delCache(email);
    const user = await findUserByEmail(email);
    if (!user) {
      throw new ApiError(404, "This account does not exist.");
    }

    const now = new Date();
    // Check if there's a pending OTP request and if the 2-minute cooldown has passed
    const otpRecord = await OTPModel.findOne({ email });
    if (otpRecord && otpRecord.expiresAt > now) {
      const remainingTime = Math.floor(
        (otpRecord.expiresAt.getTime() - now.getTime()) / 1000
      );

      throw new ApiError(
        403,
        `You can't request another OTP before ${remainingTime} seconds.`
      );
    }
    const token = generateRegisterToken({ email });
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "OTP sent to your email. Please check!",
      data: { token },
    });
    const otp = generateOTP();
    // await setCache(email, otp, 300);
    await sendResetOTPEmail(email, otp, user.name as string);
    await saveOTP(email, otp); // Save OTP with expiration
  }
);

export const resetPassword = catchAsync(async (req: Request, res: Response) => {
  let decoded: any;
  try {
    decoded = verifyToken(req.headers.authorization);
  } catch (error: any) {
    return sendError(res, error);
  }
  if (!decoded.role) {
    throw new ApiError(401, "Invalid token. Please try again.");
  }
  const email = decoded.email as string;

  const { password } = req.body;

  if (!password) {
    throw new ApiError(400, "Please provide  password ");
  }
  sendResponse(res, {
    statusCode: httpStatus.OK,
    success: true,
    message: "Password reset successfully.",
    data: null,
  });

  const user = await findUserByEmail(email);

  if (!user) {
    throw new ApiError(
      404,
      "User not found. Are you attempting something sneaky?"
    );
  }
  const newPassword = await hashPassword(password);
  user.password = newPassword;
  await user.save();
});

export const verifyOTP = catchAsync(async (req: Request, res: Response) => {
  const { otp } = req.body;

  try {
    const { token, name, email, phone } = await verifyOTPService(
      otp,
      req.headers.authorization as string
    );
    sendResponse(res, {
      statusCode: httpStatus.CREATED,
      success: true,
      message: "OTP Verified successfully.",
      data: { name, email, phone, token },
    });

    const user = await UserModel.findOne({ email });

    // Mark user as verified, if needed
    if (!user.isVerified) {
      user.isVerified = true;
      await user.save();
    }
  } catch (error: any) {
    throw new ApiError(500, error.message || "Failed to verify otp");
  }
});

export const updateUser = catchAsync(async (req: Request, res: Response) => {
  try {
    const { name, ageRange, address } = req.body;

    let decoded = req.user as IUserPayload;
    const userId = decoded.id as string;
    const user = await findUserById(userId);
    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    const updateData: any = {};

    if (name) updateData.name = name;
    if (ageRange) updateData.ageRange = ageRange;
    if (address) updateData.address = address;

    if (req.file) {
      const imagePath = `public\\images\\${req.file.filename}`;
      const publicFileURL = `/images/${req.file.filename}`;
      updateData.image = {
        path: imagePath,
        publicFileURL: publicFileURL,
      };
    }

    const updatedUser = await updateUserById(userId, updateData);
    const responseData = {
      _id: updatedUser?._id,
      name: updatedUser?.name,
      email: updatedUser?.email,
      ageRange: updatedUser?.ageRange,
      address: updatedUser?.address,
      image: updatedUser?.image?.publicFileURL || "",
    };
    if (updatedUser) {
      return sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "Profile updated.",
        data: responseData,
      });
    }
  } catch (error: any) {
    throw new ApiError(
      error.statusCode || 500,
      error.message || "Unexpected error occurred while updating user."
    );
  }
});

export const getSelfInfo = catchAsync(async (req: Request, res: Response) => {
  try {
    let decoded = req.user as IUserPayload;

    const userId = decoded.id as string;

    // Find the user in DB
    const user = await findUserById(userId);
    if (!user) {
      throw new ApiError(404, "User not found.");
    }

    // Prepare base response (common fields)
    const responseData: any = {
      _id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      address: user?.address,
      ageRange: user?.ageRange,
      image: user?.image?.publicFileURL || "",
      profile_status: user?.profile_status,
    };

    // Send final response
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Profile information retrieved successfully",
      data: responseData,
      pagination: undefined,
    });
  } catch (error: any) {
    throw new ApiError(
      error.statusCode || 500,
      error.message ||
        "Unexpected error occurred while retrieving user information."
    );
  }
});

export const deleteUser = catchAsync(async (req: Request, res: Response) => {
  try {
    const id = req.query?.id as string;
    const deleteableuser = await findUserById(id);
    if (!deleteableuser) {
      throw new ApiError(404, "User not found.");
    }
    if (deleteableuser.isDeleted) {
      throw new ApiError(404, "This account is already deleted.");
    }
    if (
      (req.user as IUserPayload)?.id !== id ||
      (req.user as IUserPayload)?.role !== "admin"
    ) {
      throw new ApiError(
        403,
        "You cannot delete this account. Please contact support"
      );
    }

    await userDelete(id, deleteableuser.email);
    return sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "Account deleted successfully",
      data: null,
    });
  } catch (error: any) {
    throw new ApiError(
      error.statusCode || 500,
      error.message || "Unexpected error occurred while deleting the user."
    );
  }
});

export const changePassword = catchAsync(
  async (req: Request, res: Response) => {
    try {
      const { oldPassword, newPassword } = req.body;
      if (!oldPassword || !newPassword) {
        throw new Error("Please provide both old password and new password.");
      }

      let decoded = req.user as IUserPayload;
      const email = decoded.email as string;
      const user = await findUserByEmail(email);

      if (!user) {
        throw new Error("User not found.");
      }

      const isMatch = await argon2.verify(user.password as string, oldPassword);
      if (!isMatch) {
        throw new ApiError(
          httpStatus.UNAUTHORIZED,
          "Old password is incorrect."
        );
      }

      const hashedNewPassword = await argon2.hash(newPassword);
      user.password = hashedNewPassword;
      await user.save();

      sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "You have successfully changed your password.",
        data: null,
      });
    } catch (error: any) {
      throw new ApiError(
        error.statusCode || 500,
        error.message || "Failed to change password."
      );
    }
  }
);

export const adminloginUser = catchAsync(
  async (req: Request, res: Response) => {
    try {
      const { email, password } = req.body;

      const user = await findUserByEmail(email);
      if (!user) {
        throw new ApiError(404, "This account does not exist.");
      }

      if (user.role !== "admin") {
        throw new ApiError(403, "Only admins can login.");
      }

      // Check password validity
      const isPasswordValid = await argon2.verify(
        user.password as string,
        password
      );
      if (!isPasswordValid) {
        throw new ApiError(401, "Wrong password!");
      }

      const userId = user._id as string;

      // Generate new token for the logged-in user
      const token = generateToken({
        id: userId,
        email: user.email,
        role: user.role,
      });

      sendResponse(res, {
        statusCode: httpStatus.OK,
        success: true,
        message: "Login complete!",
        data: {
          user: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role,
            image: user?.image?.publicFileURL,
          },
          token,
        },
      });
    } catch (error: any) {
      throw new ApiError(
        error.statusCode || 500,
        error.message || "An error occurred during admin login."
      );
    }
  }
);

//admin dashboard----------------------------------------------------------------------------------------

export const getAllUsers = catchAsync(async (req: Request, res: Response) => {
  let decoded;
  try {
    decoded = verifyToken(req.headers.authorization);
  } catch (error: any) {
    return sendError(res, error); // If token verification fails, send error response.
  }

  const adminId = decoded.id as string;

  // Verify if admin exists
  const user = await findUserById(adminId);
  if (!user) {
    throw new ApiError(404, "This admin account does not exist.");
  }

  // Pagination and filters
  const page = parseInt(req.query.page as string) || 1;
  const limit = parseInt(req.query.limit as string) || 10;
  const skip = (page - 1) * limit;

  const { date, name, email, role, requestStatus } = req.query;

  try {
    // Get the user list based on pagination and filters
    const { users, totalUsers, totalPages } = await getUserList(
      skip,
      limit,
      date as string,
      name as string,
      email as string,
      role as string,
      requestStatus as string
    );

    // Pagination logic for prevPage and nextPage
    const prevPage = page > 1 ? page - 1 : null;
    const nextPage = page < totalPages ? page + 1 : null;

    // If no users found
    if (users.length === 0) {
      return sendResponse(res, {
        statusCode: httpStatus.NO_CONTENT,
        success: true,
        message: "No user found based on your search.",
        data: [],
      });
    }

    // Populate manager info for each user
    const usersWithManagerInfo = await UserModel.populate(users, {
      path: "managerInfoId",
      select: "type businessAddress websiteLink governMentImage.publicFileURL",
    });

    // Format response data
    const responseData = usersWithManagerInfo.map((user) => ({
      _id: user._id,
      image: user.image?.publicFileURL,
      name: user.name,
      email: user.email,
      role: user.role,
      phone: user.phone,
      address: user.address,
      //isRequest: user.isRequest,
      managerInfo: user.managerInfoId
        ? {
            type: user.managerInfoId.type,
            businessAddress: user.managerInfoId.businessAddress,
            websiteLink: user.managerInfoId.websiteLink,
            governMentImage: user.managerInfoId.governMentImage?.publicFileURL,
            isRequest: user.isRequest,
          }
        : null,
      createdAt: user.createdAt,
    }));

    // Send response with pagination details
    sendResponse(res, {
      statusCode: httpStatus.OK,
      success: true,
      message: "User list retrieved successfully",
      data: responseData,
      pagination: {
        totalPage: totalPages,
        currentPage: page,
        prevPage: prevPage ?? 1,
        nextPage: nextPage ?? 1,
        limit,
        totalItem: totalUsers,
      },
    });
  } catch (error: any) {
    // Handle any errors during the user fetching or manager population
    throw new ApiError(
      error.statusCode || 500,
      error.message || "Failed to retrieve users."
    );
  }
});
