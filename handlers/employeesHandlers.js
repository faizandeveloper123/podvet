const { ipcMain } = require('electron');
const saasClient = require('./saasClient');

// HR staff roster (no login access) — backed by the multi-tenant API's
// /api/employees, distinct from clinicUsersHandlers.js which manages
// actual login accounts. See handlers/saasClient.js for the HTTP layer.
module.exports = function setupEmployeesHandlers() {
  ipcMain.handle('retrieve-employees', async (_event, page = 1, query = '') => {
    try {
      const result = await saasClient.listEmployees({ page, pageSize: 5, search: query });
      return {
        // joinedOn is optional now — new Date(null) would silently produce
        // the 1970-01-01 epoch instead of staying empty, so this must stay
        // null rather than always constructing a Date.
        data: result.data.map((emp) => ({ ...emp, joined_on: emp.joinedOn ? new Date(emp.joinedOn) : null })),
        total: result.total,
        page: result.page,
        totalPages: result.totalPages,
      };
    } catch (err) {
      console.error('[retrieve-employees]', err);
      throw err;
    }
  });

  ipcMain.handle('add-employee', async (_event, employee) => {
    try {
      await saasClient.createEmployee({
        name: employee.employeeName,
        position: employee.position,
        designation: employee.designation ?? '',
        salary: employee.salary,
        contact: employee.contactNumber,
        // Blank is fine — joined_on is optional. undefined (not sent) is
        // equivalent to null here since there's no prior value to preserve.
        joinedOn: employee.joined_on || undefined,
      });
      return { success: true, message: 'Employee Added Successfully!' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not add employee' };
    }
  });

  ipcMain.handle('edit-employee', async (_event, employee) => {
    try {
      await saasClient.updateEmployee(employee.id, {
        name: employee.name,
        position: employee.position,
        designation: employee.designation ?? '',
        salary: employee.salary,
        contact: employee.contact,
        // Unlike add-employee, a blank value here must be sent as an
        // explicit null (not omitted) — the employee already has a stored
        // joined_on, and the user clearing the field in the edit form means
        // "clear it," not "leave it unchanged."
        joinedOn: employee.joined_on || null,
      });
      return { success: true, message: 'Successfully Updated Employee' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not update employee' };
    }
  });

  ipcMain.handle('delete-employee', async (_event, employeeId) => {
    try {
      await saasClient.deleteEmployee(employeeId);
      return { success: true, message: 'Employee deleted successfully' };
    } catch (err) {
      return { success: false, message: err.message || 'Could not delete employee' };
    }
  });
};
