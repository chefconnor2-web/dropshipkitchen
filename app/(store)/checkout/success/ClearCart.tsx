"use client";

import { useEffect } from "react";
import { clearCart } from "./actions";

export default function ClearCart() {
  useEffect(() => {
    clearCart();
  }, []);
  return null;
}
