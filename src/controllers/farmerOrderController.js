const Order = require("../models/Order");
const Farmer = require("../models/Farmer");
const Supermarket = require("../models/Supermarket");
const { createAndEmitNotification } = require("../services/notificationService");

// GET farmer's orders
exports.getMyOrders = async (req, res) => {
  try {
    const farmer = await Farmer.findOne({ user: req.user._id });
    if (!farmer) {
      return res.status(404).json({ message: "Farmer profile not found" });
    }

    const orders = await Order.find({ farmer: farmer._id })
      .populate({
        path: "supermarket",
        select: "businessName businessEmail phone",
        populate: { path: "user", select: "email" }
      })
      .sort({ createdAt: -1 });

    res.json(orders);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

// ACCEPT ORDER
exports.acceptOrder = async (req, res) => {
  try {

    console.log("ACCEPT ORDER HIT");

    const farmer = await Farmer.findOne({ user: req.user._id });
    if (!farmer) {
      return res.status(404).json({ message: "Farmer profile not found" });
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        farmer: farmer._id,
        status: "PENDING"
      },
      { status: "ACCEPTED" },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found or already handled" });
    }

    const firstItem = order.items && order.items.length ? order.items[0] : null;
    const productName = firstItem?.productName || "your product";
    const acceptedPrice = Number(order.offered_price || firstItem?.pricePerKg || 0);

    const supermarketProfile = await Supermarket.findById(order.supermarket).select("user");
    if (supermarketProfile?.user) {
      await createAndEmitNotification({
        senderId: req.user._id,
        receiverId: supermarketProfile.user,
        message: `Farmer ${farmer.farmName} has accepted your order for ${productName} at Rs.${acceptedPrice}.`,
        orderId: order._id
      });
    }

    res.json({
      message: "Order accepted",
      order
    });

  } catch (err) {
    console.log(err);
    res.status(500).json({ message: err.message });
  }
};

// REJECT order
exports.rejectOrder = async (req, res) => {
  try {
    const farmer = await Farmer.findOne({ user: req.user._id });
    if (!farmer) {
      return res.status(404).json({ message: "Farmer profile not found" });
    }

    const order = await Order.findOneAndUpdate(
      {
        _id: req.params.id,
        farmer: farmer._id,
        status: "PENDING"
      },
      { status: "REJECTED" },
      { new: true }
    );

    if (!order) {
      return res.status(404).json({ message: "Order not found or already handled" });
    }

    res.json({
      message: "Order rejected",
      order
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
