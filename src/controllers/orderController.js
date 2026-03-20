const Order = require("../models/Order");
const Harvest = require("../models/Harvest");
const Delivery = require("../models/Delivery");
const Supermarket = require("../models/Supermarket");
const Farmer = require("../models/Farmer");
const Driver = require("../models/Driver");
const { getDistanceInKm } = require("../services/distanceService");
const { calculateDeliveryCharge } = require("../services/pricingService");
const { createAndEmitNotification } = require("../services/notificationService");

exports.placeOrder = async (req, res) => {
  try {

    const {
      harvestId,
      quantityKg,
      offered_price,
      deliveryLocation,
      deliveryDate,
      deliveryAddress,
      deliveryLat,
      deliveryLng
    } = req.body;

    const qty = Number(quantityKg);
    const offeredPricePerKg = Number(offered_price);

    if (
      !harvestId ||
      !deliveryDate ||
      !Number.isFinite(qty) ||
      qty <= 0 ||
      !Number.isFinite(offeredPricePerKg) ||
      offeredPricePerKg <= 0
    ) {
      return res.status(400).json({
        message: "Invalid order data"
      });
    }

    const harvest = await Harvest.findById(harvestId);

    if (!harvest || harvest.status !== "AVAILABLE") {
      return res.status(404).json({
        message: "Harvest not available"
      });
    }

    if (!harvest.farmer) {
      return res.status(400).json({
        message: "Harvest farmer not assigned"
      });
    }

    if (qty > harvest.quantityKg) {
      return res.status(400).json({
        message: "Requested quantity exceeds stock"
      });
    }

    const totalPrice = qty * offeredPricePerKg;

    const resolvedDeliveryLocation = deliveryLocation || {
      address: deliveryAddress,
      lat: Number(deliveryLat),
      lng: Number(deliveryLng)
    };
    if (
      !resolvedDeliveryLocation ||
      resolvedDeliveryLocation.lat == null ||
      resolvedDeliveryLocation.lng == null
    ) {
      return res.status(400).json({
        message: "Delivery location required"
      });
    }

    const supermarket = await Supermarket.findOne({ user: req.user._id });
    if (!supermarket) {
      return res.status(404).json({ message: "Supermarket profile not found" });
    }

    const order = await Order.create({
      supermarket: supermarket._id,
      farmer: harvest.farmer,
      harvest: harvest._id,

      items: [
        {
          productName: harvest.productName,
          quantityKg: qty,
          pricePerKg: offeredPricePerKg
        }
      ],

      offered_price: offeredPricePerKg,
      deliveryLocation: resolvedDeliveryLocation,
      deliveryDate,
      totalPrice,
      status: "PENDING"
    });

    const notificationMessage = `New order for ${harvest.productName} (${qty} KG) at Rs ${offeredPricePerKg}/kg`;

    const farmerProfile = await Farmer.findById(harvest.farmer).select("user");
    if (farmerProfile?.user) {
      await createAndEmitNotification({
        senderId: req.user._id,
        receiverId: farmerProfile.user,
        message: notificationMessage,
        orderId: order._id
      });
    }

    res.status(201).json({
      message: "Order placed successfully",
      order
    });

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
exports.getMyOrders = async (req, res) => {
  try {

    const supermarket = await Supermarket.findOne({ user: req.user._id });
    if (!supermarket) {
      return res.status(404).json({ message: "Supermarket profile not found" });
    }

    const orders = await Order.find({
      supermarket: supermarket._id
    })
      .populate({
        path: "farmer",
        select: "farmName",
        populate: { path: "user", select: "email" }
      })
      .sort({ createdAt: -1 });

    res.json(orders);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};
exports.getOrderById = async (req, res) => {
  try {

    const order = await Order.findById(req.params.id)
      .populate({
        path: "farmer",
        select: "farmName",
        populate: { path: "user", select: "email" }
      })
      .populate({
        path: "supermarket",
        select: "businessName businessEmail phone",
        populate: { path: "user", select: "email" }
      });

    if (!order) {
      return res.status(404).json({
        message: "Order not found"
      });
    }

    res.json(order);

  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

exports.payOrder = async (req, res) => {
  try {
    const supermarket = await Supermarket.findOne({ user: req.user._id });
    if (!supermarket) {
      return res.status(404).json({ message: "Supermarket profile not found" });
    }

    const order = await Order.findOne({
      _id: req.params.id,
      supermarket: supermarket._id
    });

    if (!order) {
      return res.status(404).json({ message: "Order not found" });
    }

    if (order.status !== "ACCEPTED") {
      return res.status(400).json({
        message: "Only accepted orders can be paid"
      });
    }

    const existingDelivery = await Delivery.findOne({ order: order._id });
    if (existingDelivery) {
      return res.status(400).json({
        message: "Delivery already created for this order"
      });
    }

    let harvest = null;
    if (order.harvest) {
      harvest = await Harvest.findById(order.harvest);
    }
    if (!harvest) {
      const firstItem = order.items && order.items.length ? order.items[0] : null;
      if (firstItem) {
        harvest = await Harvest.findOne({
          farmer: order.farmer,
          productName: firstItem.productName
        });
      }
    }

    const pickupLocation = harvest && harvest.pickupLocation
      ? harvest.pickupLocation
      : { address: "Unknown", lat: null, lng: null };
    const dropLocation = order.deliveryLocation || {};

    if (
      pickupLocation.lat == null ||
      pickupLocation.lng == null ||
      dropLocation.lat == null ||
      dropLocation.lng == null
    ) {
      return res.status(400).json({
        message: "Pickup and drop locations are required to create delivery"
      });
    }

    const distanceKm = await getDistanceInKm(
      pickupLocation.lat,
      pickupLocation.lng,
      dropLocation.lat,
      dropLocation.lng
    );

    const totalLoadKg = order.items.reduce(
      (sum, item) => sum + item.quantityKg,
      0
    );

    const deliveryCharge = calculateDeliveryCharge({
      distanceKm,
      loadKg: totalLoadKg
    });

    order.status = "PAID";
    await order.save();

    const delivery = await Delivery.create({
      order: order._id,
      farmer: order.farmer,
      supermarket: order.supermarket,
      pickupLocation,
      dropLocation,
      deliveryDate: order.deliveryDate,
      distanceKm,
      loadKg: totalLoadKg,
      deliveryCharge,
      status: "AVAILABLE"
    });

    const farmerProfile = await Farmer.findById(order.farmer).select("user district");

    const nearbyDrivers = await Driver.find({
      isAvailable: true,
      isVerified: true,
      serviceDistrict: farmerProfile?.district
    }).select("user");

    const pickupLabel = pickupLocation?.address || "Farm pickup location";
    const dropLabel = dropLocation?.address || "Supermarket location";

    await Promise.all(
      nearbyDrivers
        .filter((driver) => driver.user)
        .map((driver) =>
          createAndEmitNotification({
            senderId: req.user._id,
            receiverId: driver.user,
            message: `New Delivery Available! Pickup from ${pickupLabel} to ${dropLabel}.`,
            orderId: order._id,
            deliveryId: delivery._id
          })
        )
    );

    if (farmerProfile?.user) {
      await createAndEmitNotification({
        senderId: req.user._id,
        receiverId: farmerProfile.user,
        message: `Payment received for accepted order. Delivery #${delivery._id} has been created.`,
        orderId: order._id,
        deliveryId: delivery._id
      });
    }

    res.json({
      message: "Order paid and delivery created",
      order,
      delivery
    });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
};

