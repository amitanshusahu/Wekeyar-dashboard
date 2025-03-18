import { Request, Response } from "express";
import { PrismaClient } from "@prisma/client";
import { SummaryReport, NonBuyingCustomer, MonthlyNonBuyingCustomer } from "src/types/types";
import { subDays, subWeeks, subMonths } from "date-fns";

const prisma = new PrismaClient();

/**
 * 1. Summary Report
 */
export const getSummary = async (_req: Request, res: Response) => {
  try {
    const totalCustomers = await prisma.customer.count();
    const totalRevenueData = await prisma.bill.aggregate({
      _sum: { netAmount: true },
    });

    const currentDate = new Date();
    const lastMonthStart = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    const lastMonthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), 0);

    console.log("Last Month Start:", lastMonthStart);
    console.log("Last Month End:", lastMonthEnd);

    // Fetch active customers
    const activeCustomersList = await prisma.customer.findMany({
      where: { bills: { some: { date: { gte: lastMonthStart, lte: lastMonthEnd } } } },
      select: {
        id: true,
        name: true,
        phone: true,
      },
    });

    console.log("Active Customers Count:", activeCustomersList.length);
    console.log("Active Customers Details:", activeCustomersList);

    const inactiveCustomers = totalCustomers - activeCustomersList.length;
    const avgMonthlyRevenue = totalRevenueData._sum.netAmount
      ? totalRevenueData._sum.netAmount / 12
      : 0;

    const summary: SummaryReport = {
      totalCustomers,
      activeCustomers: activeCustomersList.length,
      inactiveCustomers,
      totalRevenue: totalRevenueData._sum.netAmount || 0,
      avgMonthlyRevenue,
    };

    res.json(summary);
  } catch (error) {
    console.error("Error in getSummary:", error);
    res.status(500).json({ error: "Internal server error", details: error });
  }
};

/**
 * 2. Non-Buying Customer Report (Default 90 Days)
 */
export const getNonBuyingCustomers = async (req: Request, res: Response) => {
  try {
    const { region, storeId, customerType, days = 90 } = req.query;
    const cutoffDate = new Date();
    cutoffDate.setDate(cutoffDate.getDate() - Number(days));

    const customers = await prisma.customer.findMany({
      where: {
        bills: { none: { date: { gte: cutoffDate } } },
        ...(storeId ? { bills: { some: { storeId: Number(storeId) } } } : {}),
        ...(region ? { address: { contains: region as string } } : {}),
        ...(customerType ? { customerType: customerType as string } : {}),
      },
      select: {
        id: true,
        name: true,
        phone: true,
        bills: {
          select: {
            date: true,
            netAmount: true,
          },
          orderBy: { date: "desc" },
          take: 1,
        },
      },
    });

    const result: NonBuyingCustomer[] = customers.map((customer) => ({
      id: customer.id,
      name: customer.name,
      phone: customer.phone,
      lastPurchaseDate: customer.bills.length ? customer.bills[0].date : null,
      totalPurchaseValue: customer.bills.reduce((acc, bill) => acc + bill.netAmount, 0),
    }));

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error", details: error });
  }
};

/**
 * 3. Non-Buying Customer List (Monthly Buyers)
 */
export const getNonBuyingMonthlyCustomers = async (_req: Request, res: Response) => {
  try {
    const currentDate = new Date();
    const lastMonthStart = new Date(currentDate.getFullYear(), currentDate.getMonth() - 1, 1);
    const lastMonthEnd = new Date(currentDate.getFullYear(), currentDate.getMonth(), 0);

    const customers = await prisma.customer.findMany({
      where: {
        bills: {
          some: { date: { lt: lastMonthStart } },
          none: { date: { gte: lastMonthStart, lte: lastMonthEnd } },
        },
      },
      select: {
        id: true,
        name: true,
        phone: true,
        bills: {
          select: { date: true, netAmount: true },
          orderBy: { date: "desc" },
        },
      },
    });

    const result: MonthlyNonBuyingCustomer[] = customers.map((customer) => {
      const totalAmount = customer.bills.reduce((acc, bill) => acc + bill.netAmount, 0);
      const monthsCount = new Set(
        customer.bills.map((bill) => `${bill.date.getFullYear()}-${bill.date.getMonth()}`)
      ).size;

      return {
        id: customer.id,
        name: customer.name,
        phone: customer.phone,
        monthlyAvgPurchase: monthsCount ? totalAmount / monthsCount : 0,
        lastPurchaseDate: customer.bills.length ? customer.bills[0].date : null,
      };
    });

    res.json(result);
  } catch (error) {
    res.status(500).json({ error: "Internal server error", details: error });
  }
};

/**
 * 4. Customer Purchase History
 */
export const getCustomerReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { startDate, endDate, storeId } = req.query;

    // Convert query params to proper types
    const start = startDate ? new Date(startDate as string) : undefined;
    const end = endDate ? new Date(endDate as string) : undefined;

    const whereCondition: any = {};

    if (start && end) {
      whereCondition.date = {
        gte: start,
        lte: end, 
      };
    }

    if (storeId) {
      whereCondition.storeId = Number(storeId);
    }

    // Fetch all relevant bills
    const bills = await prisma.bill.findMany({
      where: whereCondition,
      include: {
        customer: true,
        store: true,
      },
    });

    // Group by customer
    const customerData = new Map();

    bills.forEach((bill) => {
      const { id, name, phone } = bill.customer;
      const storeName = bill.store.storeName;

      if (!customerData.has(id)) {
        customerData.set(id, {
          customerName: name,
          mobileNo: phone,
          totalSales: 0,
          purchaseFrequency: 0, // Fix: Count each bill separately
          stores: new Map(),
        });
      }

      const customerEntry = customerData.get(id);

      // Update total sales
      customerEntry.totalSales += bill.netAmount;

      // Fix: Increment purchase frequency per bill, not per store
      customerEntry.purchaseFrequency += 1;

      // Track sales per store
      if (!customerEntry.stores.has(storeName)) {
        customerEntry.stores.set(storeName, 0);
      }
      customerEntry.stores.set(storeName, customerEntry.stores.get(storeName) + bill.netAmount);
    });

    // Convert Map to JSON-friendly format
    const result = Array.from(customerData.values()).map((entry) => ({
      customerName: entry.customerName,
      mobileNo: entry.mobileNo,
      totalSales: entry.totalSales,
      purchaseFrequency: entry.purchaseFrequency, // Fix: Now counts every bill correctly
      stores: Array.from(entry.stores.entries() as [string, number][]).map(([storeName, sales]) => ({
        storeName,
        sales,
      })),
    }));

   res.json(result);
   return;
  } catch (error) {
    console.error("Error fetching customer report:", error);
   res.status(500).json({ error: "Internal server error" });
    return;
  }
};

/**
 * 5. Store-wise Sales Report
 */
export const getStoreWiseSalesReport = async (req: Request, res: Response): Promise<void> => {
  try {
    const { date } = req.query;
    const selectedDate = date ? new Date(date as string) : new Date(); // Default to today

    const previousDay = subDays(selectedDate, 1);
    const previousWeek = subWeeks(selectedDate, 1);
    const previousMonth = subMonths(selectedDate, 1);

    // Get all stores
    const stores = await prisma.store.findMany();

    // Function to get sales data for a specific date
    const fetchSalesData = async (storeId: number, targetDate: Date) => {
      const sales = await prisma.bill.findMany({
        where: {
          storeId,
          date: {
            gte: new Date(targetDate.setHours(0, 0, 0, 0)),
            lt: new Date(targetDate.setHours(23, 59, 59, 999)),
          },
        },
        select: {
          netAmount: true,
          isUploaded: true,
          billDetails: {
            select: {
              id: true, // Counting items sold
            },
          },
        },
      });

      return {
        totalNetAmount: sales.reduce((sum, bill) => sum + bill.netAmount, 0),
        totalBills: sales.length,
        totalItemsSold: sales.reduce((sum, bill) => sum + bill.billDetails.length, 0),
        isUploaded: sales.length > 0 ? sales[0].isUploaded : false,
      };
    };

    // Function to find the latest available sales before a given date
    const fetchLatestAvailableSales = async (storeId: number, referenceDate: Date) => {
      const latestBill = await prisma.bill.findFirst({
        where: {
          storeId,
          date: { lt: referenceDate },
        },
        orderBy: { date: "desc" },
        select: { date: true },
      });

      if (!latestBill) {
        return {
          totalNetAmount: 0,
          totalBills: 0,
          totalItemsSold: 0,
          referenceDate: null, // No data available
        };
      }

      return await fetchSalesData(storeId, latestBill.date);
    };

    // Generate report for all stores
    const storeReports = await Promise.all(
      stores.map(async (store) => {
        const currentSales = await fetchSalesData(store.id, selectedDate);
        const previousDaySales = await fetchLatestAvailableSales(store.id, previousDay);
        const previousWeekSales = await fetchLatestAvailableSales(store.id, previousWeek);
        const previousMonthSales = await fetchLatestAvailableSales(store.id, previousMonth);

        return {
          storeName: store.storeName,
          address: store.address,
          salesData: {
            totalNetAmount: currentSales.totalNetAmount,
            totalBills: currentSales.totalBills,
            totalItemsSold: currentSales.totalItemsSold,
            isUploaded: currentSales.isUploaded,
          },
          trends: {
            previousDay: previousDaySales,
            previousWeek: previousWeekSales,
            previousMonth: previousMonthSales,
          },
        };
      })
    );

    res.status(200).json({
      selectedDate: selectedDate.toISOString().split("T")[0],
      storeReports,
    });
  } catch (error) {
    console.error("Error fetching store-wise sales report:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};

export const getAllCustomers = async (_req: Request, res: Response): Promise<void> => {
  try {
    const currentDate = new Date();
    const lastMonthStart = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth() - 1, 1));
    const lastMonthEnd = new Date(Date.UTC(currentDate.getUTCFullYear(), currentDate.getUTCMonth(), 0, 23, 59, 59));

    console.log("Last Month Start (UTC):", lastMonthStart.toISOString());
    console.log("Last Month End (UTC):", lastMonthEnd.toISOString());

    // Fetch all customers with their most recent purchase date
    const customers = await prisma.customer.findMany({
      select: {
        name: true,
        phone: true,
        address: true,
        bills: {
          select: { date: true },
          orderBy: { date: "desc" },
          take: 1, // Get the most recent bill
        },
      },
    });

    console.log("Fetched Customers:", customers);

    // Process each customer to determine active/inactive status
    const result = customers.map((customer) => {
      const lastPurchaseDate = customer.bills.length ? new Date(customer.bills[0].date) : null;

      console.log(`Customer: ${customer.name}, Last Purchase (Raw):`, customer.bills[0]?.date);
      console.log(`Customer: ${customer.name}, Last Purchase (Parsed):`, lastPurchaseDate?.toISOString());

      let isActive = false;
      if (lastPurchaseDate) {
        isActive =
          lastPurchaseDate.getTime() >= lastMonthStart.getTime() &&
          lastPurchaseDate.getTime() <= lastMonthEnd.getTime();
      }

      console.log(`Customer: ${customer.name}, Status: ${isActive ? "Active" : "Inactive"}`);

      return {
        name: customer.name,
        phone: customer.phone,
        address: customer.address,
        status: isActive ? "Active" : "Inactive",
      };
    });

    res.status(200).json(result);
  } catch (error) {
    console.error("Error fetching customers:", error);
    res.status(500).json({ error: "Internal server error" });
  }
};



/**
 * Get yearly revenue data for the last 5 years
 */
export const getYearlyRevenue = async (_req: Request, res: Response) => {
  try {
    const currentYear = new Date().getFullYear();
    const startYear = currentYear - 4; // Last 5 years

    // Generate array of years to query
    const years = Array.from({ length: 5 }, (_, i) => startYear + i);

    const yearlyRevenue = await Promise.all(
      years.map(async (year) => {
        const startDate = new Date(`${year}-01-01T00:00:00.000Z`);
        const endDate = new Date(`${year}-12-31T23:59:59.999Z`);

        const revenue = await prisma.bill.aggregate({
          _sum: {
            netAmount: true,
          },
          where: {
            date: {
              gte: startDate,
              lte: endDate,
            },
          },
        });

        return {
          year,
          revenue: revenue._sum.netAmount || 0,
        };
      })
    );

    res.status(200).json(yearlyRevenue);
  } catch (error) {
    console.error("Error fetching yearly revenue:", error);
    res.status(500).json({ error: "Failed to fetch yearly revenue data" });
  }
};

/**
 * Get monthly revenue data for a specific year
 */
export const getMonthlyRevenue = async (req: Request, res: Response) => {
  try {
    const { year } = req.params;
    const selectedYear = parseInt(year) || new Date().getFullYear();
    
    // Generate all months of the year
    const months = Array.from({ length: 12 }, (_, i) => i + 1);
    
    const monthlyRevenue = await Promise.all(
      months.map(async (month) => {
        // Create date range for the month
        const startDate = new Date(`${selectedYear}-${month.toString().padStart(2, '0')}-01T00:00:00.000Z`);
        
        // Calculate the last day of the month
        const lastDay = new Date(selectedYear, month, 0).getDate();
        const endDate = new Date(`${selectedYear}-${month.toString().padStart(2, '0')}-${lastDay}T23:59:59.999Z`);
        
        const revenue = await prisma.bill.aggregate({
          _sum: {
            netAmount: true
          },
          where: {
            date: {
              gte: startDate,
              lte: endDate
            }
          }
        });
        
        return {
          month,
          monthName: new Date(selectedYear, month - 1, 1).toLocaleString('default', { month: 'short' }),
          revenue: revenue._sum.netAmount || 0
        };
      })
    );
    
    res.status(200).json(monthlyRevenue);
  } catch (error) {
    console.error('Error fetching monthly revenue:', error);
    res.status(500).json({ error: 'Failed to fetch monthly revenue data' });
  }
};

/**
 * Get available years for filtering
 */
export const getAvailableYears = async (_req: Request, res: Response) => {
  try {
    // Find earliest and latest years in the database
    const earliestBill = await prisma.bill.findFirst({
      orderBy: {
        date: 'asc',
      },
      select: {
        date: true,
      },
    });

    const latestBill = await prisma.bill.findFirst({
      orderBy: {
        date: 'desc',
      },
      select: {
        date: true,
      },
    });

    // Default to current year if no data
    const currentYear = new Date().getFullYear();
    const earliestYear = earliestBill ? earliestBill.date.getFullYear() : currentYear;
    const latestYear = latestBill ? latestBill.date.getFullYear() : currentYear;

    // Generate array of available years
    const years = Array.from(
      { length: latestYear - earliestYear + 1 },
      (_, i) => earliestYear + i
    );

    res.status(200).json(years);
  } catch (error) {
    console.error('Error fetching available years:', error);
    res.status(500).json({ error: 'Failed to fetch available years' });
  }
};









